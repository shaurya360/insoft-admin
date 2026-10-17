// Shared vendor / client data access and forms (used by every feature).
import { sb } from './supabase.js';
import { openModal, createCombobox, createTagInput, esc, h, setLoading, toast, errorMessage, ICONS } from './ui.js';

const PAGE = 1000;

/** Fetch every row of a query, paging past the API row limit. */
export async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

export const fetchVendors = () =>
  fetchAll(() => sb.from('vendors').select('id, name, phone, address, poc_name, poc_phone').order('name'));

export const fetchClients = () =>
  fetchAll(() => sb.from('clients').select('id, name, phone, address, created_at, updated_at').order('name'));

/** Categories, brands and the category↔brand pairs that are in use. */
export async function fetchTaxonomy() {
  const [categories, brands, pairs] = await Promise.all([
    fetchAll(() => sb.from('categories').select('id, name').order('name')),
    fetchAll(() => sb.from('brands').select('id, name').order('name')),
    fetchAll(() => sb.from('offering_pairs').select('category_id, brand_id')),
  ]);
  return { categories, brands, pairs };
}

const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const phoneDigits = (s) => String(s ?? '').replace(/\D/g, '');
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function validatePhone(phone) {
  if (!phone) return null;
  const n = phoneDigits(phone).length;
  if (n < 7 || n > 15) return 'Enter a valid phone number (7–15 digits).';
  return null;
}

/** Records with the same name (case-insensitive) — a soft duplicate warning. */
async function findSameName(table, name, excludeId) {
  let q = sb.from(table).select('id, name, phone').ilike('name', likeEscape(name)).limit(3);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q;
  return data || [];
}

function contactFields(rec = {}, labels = { name: 'Name', phone: 'Phone number' }) {
  return `
    <div class="form-grid">
      <div class="field span-2">
        <label class="req" for="f-name">${labels.name}</label>
        <input class="input" id="f-name" name="name" maxlength="160" required value="${esc(rec.name)}">
      </div>
      <div class="field">
        <label for="f-phone">${labels.phone}</label>
        <input class="input" id="f-phone" name="phone" type="tel" inputmode="tel" maxlength="40" value="${esc(rec.phone)}" placeholder="+91 98765 43210">
      </div>
      <div class="field span-2">
        <label for="f-address">Address</label>
        <textarea class="input" id="f-address" name="address" maxlength="500" rows="2">${esc(rec.address)}</textarea>
      </div>
    </div>
    <div class="alert alert-error" data-error hidden style="margin-top:14px"></div>
    <div class="alert alert-warning" data-warning hidden style="margin-top:14px"></div>`;
}

function showMsg(root, sel, text) {
  const el = root.querySelector(sel);
  el.textContent = text || '';
  el.hidden = !text;
}

/* ------------------------------------------------------------------ */
/* Vendor form                                                         */
/* ------------------------------------------------------------------ */

/**
 * Opens the add / edit vendor form.
 * Resolves with { id, name, phone, address } when saved, or null if cancelled.
 */
export async function openVendorForm(vendorId = null, prefill = {}) {
  let vendor = { ...prefill, offerings: [] };
  let tax;
  try {
    const tasks = [fetchTaxonomy()];
    if (vendorId) tasks.push(sb.from('vendor_directory').select('*').eq('id', vendorId).single());
    const [t, v] = await Promise.all(tasks);
    tax = t;
    if (v) {
      if (v.error) throw v.error;
      vendor = v.data;
    }
  } catch (e) {
    toast(errorMessage(e), 'error');
    return null;
  }

  return new Promise((resolve) => {
    let saved = null;
    const formId = 'vendor-form-' + Date.now();
    const form = h(`<form novalidate id="${formId}">
      <h4 style="margin-bottom:10px">Company details</h4>
      ${contactFields(vendor, { name: 'Company name', phone: 'Owner mobile' })}
      <div class="form-section">
        <div class="form-section-head">
          <div><h4>Point of contact</h4><div class="hint">The person you usually deal with at this company (optional).</div></div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="f-poc-name">Contact person name</label>
            <input class="input" id="f-poc-name" name="pocName" maxlength="160" value="${esc(vendor.poc_name)}" placeholder="e.g. Ramesh Kumar">
          </div>
          <div class="field">
            <label for="f-poc-phone">Contact number</label>
            <input class="input" id="f-poc-phone" name="pocPhone" type="tel" inputmode="tel" maxlength="40" value="${esc(vendor.poc_phone)}" placeholder="+91 98765 43210">
          </div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-head">
          <div><h4>Products supplied</h4><div class="hint">Add each product category and the brands this vendor supplies in it.</div></div>
          <button type="button" class="btn btn-sm" data-add-offer>${ICONS.plus} Category</button>
        </div>
        <div data-offers></div>
      </div>
    </form>`);
    // move alerts below the offerings
    form.append(form.querySelector('[data-error]'), form.querySelector('[data-warning]'));

    const m = openModal({
      title: vendorId ? 'Edit vendor' : 'Add new vendor',
      body: form,
      wide: true,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="${formId}" class="btn btn-primary" data-save>${vendorId ? 'Save changes' : 'Add vendor'}</button>`,
    });

    const categoryNames = () => tax.categories.map((c) => c.name);
    const brandsFor = (catName) => {
      const cat = tax.categories.find((c) => c.name.toLowerCase() === cleanText(catName).toLowerCase());
      const paired = new Set(cat ? tax.pairs.filter((p) => p.category_id === cat.id).map((p) => p.brand_id) : []);
      const named = tax.brands.map((b) => ({ name: b.name, paired: paired.has(b.id) }));
      return [...named.filter((b) => b.paired), ...named.filter((b) => !b.paired)].map((b) => b.name);
    };

    const offersEl = form.querySelector('[data-offers]');
    const rows = [];
    function addRow(category = '', brands = []) {
      const row = h(`<div class="offer-row">
          <input type="text" maxlength="80" aria-label="Category" value="${esc(category)}">
          <div aria-label="Brands"></div>
          <button type="button" class="icon-btn" aria-label="Remove category" title="Remove">${ICONS.trash}</button>
        </div>`);
      offersEl.appendChild(row);
      const catInput = row.querySelector('input');
      createCombobox(catInput, {
        placeholder: 'Category, e.g. Lighting',
        keepText: true,
        getOptions: () => categoryNames().map((n) => ({ value: n, label: n })),
        allowCreate: (t) => `Add new category “${t}”`,
        onCreate: (t) => { catInput.value = t; },
      });
      const tagInput = createTagInput(row.querySelector('[aria-label="Brands"]'), {
        values: brands,
        placeholder: 'Brands, e.g. Philips — press Enter',
        suggestions: () => brandsFor(catInput.value),
      });
      const entry = { row, category: () => cleanText(catInput.value), brands: () => tagInput.values() };
      rows.push(entry);
      row.querySelector('.icon-btn').addEventListener('click', () => {
        rows.splice(rows.indexOf(entry), 1);
        row.remove();
      });
      return catInput;
    }
    (vendor.offerings || []).forEach((o) => addRow(o.category, o.brands.map((b) => b.name)));
    if (!rows.length) addRow();
    form.querySelector('[data-add-offer]').addEventListener('click', () => addRow().focus());

    let confirmedDuplicate = false;
    form.addEventListener('input', () => { confirmedDuplicate = false; showMsg(form, '[data-warning]', ''); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showMsg(form, '[data-error]', '');
      const name = cleanText(form.name.value);
      const phone = cleanText(form.phone.value);
      const address = form.address.value.trim();
      form.name.classList.toggle('invalid', !name);
      if (!name) return showMsg(form, '[data-error]', 'Company name is required.');
      const phoneErr = validatePhone(phone);
      form.phone.classList.toggle('invalid', !!phoneErr);
      if (phoneErr) return showMsg(form, '[data-error]', 'Owner mobile: ' + phoneErr);
      const pocName = cleanText(form.pocName.value);
      const pocPhone = cleanText(form.pocPhone.value);
      const pocErr = validatePhone(pocPhone);
      form.pocPhone.classList.toggle('invalid', !!pocErr);
      if (pocErr) return showMsg(form, '[data-error]', 'Contact number: ' + pocErr);

      // Merge rows with the same category so relationships stay clean.
      const merged = new Map();
      for (const r of rows) {
        const cat = r.category();
        const brands = r.brands();
        if (!cat) {
          if (brands.length) return showMsg(form, '[data-error]', 'Enter a category for every row that has brands.');
          continue;
        }
        const key = cat.toLowerCase();
        if (!merged.has(key)) merged.set(key, { category: cat, brands: [] });
        merged.get(key).brands.push(...brands);
      }
      const offerings = [...merged.values()];

      const btn = m.footer.querySelector('[data-save]');
      setLoading(btn, true);
      try {
        if (!confirmedDuplicate) {
          const same = await findSameName('vendors', name, vendorId);
          if (same.length) {
            confirmedDuplicate = true;
            showMsg(form, '[data-warning]',
              `A vendor named “${same[0].name}”${same[0].phone ? ` (${same[0].phone})` : ''} already exists. ` +
              'Check that this is not a duplicate, then press Save again to continue.');
            return;
          }
        }
        const { data: id, error } = await sb.rpc('save_vendor', {
          p_id: vendorId, p_name: name, p_phone: phone || null, p_address: address || null, p_offerings: offerings,
          p_poc_name: pocName || null, p_poc_phone: pocPhone || null,
        });
        if (error) throw error;
        saved = { id, name, phone: phone || null, address: address || null, poc_name: pocName || null, poc_phone: pocPhone || null };
        toast(vendorId ? 'Vendor updated' : 'Vendor added', 'success');
        m.close();
      } catch (err) {
        showMsg(form, '[data-error]', errorMessage(err));
      } finally {
        setLoading(btn, false);
      }
    });

    m.onClose(() => resolve(saved));
  });
}

/* ------------------------------------------------------------------ */
/* Client form                                                         */
/* ------------------------------------------------------------------ */

/**
 * Opens the add / edit client form.
 * Resolves with the saved client row, or null if cancelled.
 */
export async function openClientForm(clientId = null, prefill = {}) {
  let client = { ...prefill };
  if (clientId) {
    const { data, error } = await sb.from('clients').select('*').eq('id', clientId).single();
    if (error) { toast(errorMessage(error), 'error'); return null; }
    client = data;
  }

  return new Promise((resolve) => {
    let saved = null;
    const formId = 'client-form-' + Date.now();
    const form = h(`<form novalidate id="${formId}">${contactFields(client)}</form>`);
    const m = openModal({
      title: clientId ? 'Edit client' : 'Add new client',
      body: form,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="${formId}" class="btn btn-primary" data-save>${clientId ? 'Save changes' : 'Add client'}</button>`,
    });

    let confirmedDuplicate = false;
    form.addEventListener('input', () => { confirmedDuplicate = false; showMsg(form, '[data-warning]', ''); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showMsg(form, '[data-error]', '');
      const name = cleanText(form.name.value);
      const phone = cleanText(form.phone.value);
      const address = form.address.value.trim();
      form.name.classList.toggle('invalid', !name);
      if (!name) return showMsg(form, '[data-error]', 'Client name is required.');
      const phoneErr = validatePhone(phone);
      form.phone.classList.toggle('invalid', !!phoneErr);
      if (phoneErr) return showMsg(form, '[data-error]', phoneErr);

      const btn = m.footer.querySelector('[data-save]');
      setLoading(btn, true);
      try {
        if (!confirmedDuplicate) {
          const same = await findSameName('clients', name, clientId);
          if (same.length) {
            confirmedDuplicate = true;
            showMsg(form, '[data-warning]',
              `A client named “${same[0].name}”${same[0].phone ? ` (${same[0].phone})` : ''} already exists. ` +
              'Check that this is not a duplicate, then press Save again to continue.');
            return;
          }
        }
        const row = { name, phone: phone || null, address: address || null };
        const query = clientId
          ? sb.from('clients').update(row).eq('id', clientId).select().single()
          : sb.from('clients').insert(row).select().single();
        const { data, error } = await query;
        if (error) throw error;
        saved = data;
        toast(clientId ? 'Client updated' : 'Client added', 'success');
        m.close();
      } catch (err) {
        showMsg(form, '[data-error]', errorMessage(err));
      } finally {
        setLoading(btn, false);
      }
    });

    m.onClose(() => resolve(saved));
  });
}
