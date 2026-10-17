import { initShell } from '../layout.js';
import { sb, isAdmin } from '../supabase.js';
import {
  ICONS, esc, inr, fmtDate, statusBadge, $, openModal, confirmDialog, createCombobox, toast, errorMessage,
  loadingBlock, emptyState, debounce, telHref, waHref, phoneActions, copyText, h,
} from '../ui.js';
import { fetchTaxonomy, openVendorForm } from '../entities.js';

await initShell('vendors');

$('#add-vendor').innerHTML = `${ICONS.plus} Add New Vendor`;
$('#search-wrap').insertAdjacentHTML('afterbegin', ICONS.search);

const results = $('#results');
const countEl = $('#count');
const filters = { q: '', category: null, brand: null };
let tax = { categories: [], brands: [], pairs: [] };
let vendors = [];
let seq = 0;

/* ---------------- Filter options from real relationships ---------------- */
function categoryOptions() {
  const used = new Set(tax.pairs.map((p) => p.category_id));
  return tax.categories.filter((c) => used.has(c.id)).map((c) => ({ value: c.id, label: c.name }));
}

function brandOptions() {
  const ids = new Set(
    tax.pairs.filter((p) => p.brand_id && (!filters.category || p.category_id === filters.category)).map((p) => p.brand_id),
  );
  return tax.brands.filter((b) => ids.has(b.id)).map((b) => ({ value: b.id, label: b.name }));
}

const catCombo = createCombobox($('#category'), {
  placeholder: 'All categories',
  getOptions: categoryOptions,
  onChange: (o) => {
    filters.category = o?.value ?? null;
    // Keep the brand only if this category actually has it.
    if (filters.brand && !brandOptions().some((b) => b.value === filters.brand)) {
      filters.brand = null;
      brandCombo.clear();
    }
    search();
  },
});
const brandCombo = createCombobox($('#brand'), {
  placeholder: 'All brands',
  getOptions: brandOptions,
  onChange: (o) => { filters.brand = o?.value ?? null; search(); },
});

$('#q').addEventListener('input', debounce((e) => { filters.q = e.target.value; search(); }, 200));
$('#clear').addEventListener('click', () => {
  Object.assign(filters, { q: '', category: null, brand: null });
  $('#q').value = '';
  catCombo.clear();
  brandCombo.clear();
  search();
});

function syncUrl() {
  const p = new URLSearchParams();
  if (filters.q.trim()) p.set('q', filters.q.trim());
  if (filters.category) p.set('category', filters.category);
  if (filters.brand) p.set('brand', filters.brand);
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
}

/* ---------------- Search (database-side) ---------------- */
async function search() {
  syncUrl();
  const my = ++seq;
  if (!vendors.length) results.innerHTML = loadingBlock('Searching…');
  const { data, error } = await sb.rpc('search_vendors', {
    p_category_id: filters.category, p_brand_id: filters.brand, p_query: filters.q.trim() || null,
  });
  if (my !== seq) return; // a newer search is in flight
  if (error) {
    results.innerHTML = `<div class="alert alert-error">${esc(errorMessage(error))}</div>`;
    return;
  }
  vendors = data;
  render();
}

function render() {
  const anyFilter = filters.q.trim() || filters.category || filters.brand;
  countEl.textContent = vendors.length
    ? `${vendors.length} vendor${vendors.length === 1 ? '' : 's'}${anyFilter ? ' match' : ''}`
    : '';
  if (!vendors.length) {
    results.innerHTML = anyFilter
      ? emptyState({ icon: 'search', title: 'No vendors match', text: 'Try a different category, brand or search term.' })
      : `<div class="card">${emptyState({
          icon: 'store', title: 'No vendors yet',
          text: 'Vendors you add here (or in the Money Manager) appear in one shared directory.',
          action: `<button type="button" class="btn btn-primary" data-empty-add>${ICONS.plus} Add New Vendor</button>`,
        })}</div>`;
    results.querySelector('[data-empty-add]')?.addEventListener('click', addVendor);
    return;
  }
  const q = filters.q.trim().toLowerCase();
  results.innerHTML = `<div class="vendor-grid">${vendors.map((v) => vendorCard(v, q)).join('')}</div>`;
}

function offeringsHtml(offerings, q) {
  if (!offerings.length) return '<div class="muted small">No product categories added yet.</div>';
  return `<div class="offerings">${offerings.map((o) => {
    const catHit = o.category_id === filters.category || (q && o.category.toLowerCase().includes(q));
    return `<div class="offering${catHit ? ' hit' : ''}"><span class="cat">${esc(o.category)}:</span>
      ${o.brands.length
        ? o.brands.map((b) => `<span class="chip${b.id === filters.brand || (q && b.name.toLowerCase().includes(q)) ? ' hit' : ''}">${esc(b.name)}</span>`).join('')
        : '<span class="muted small">Any brand</span>'}
    </div>`;
  }).join('')}</div>`;
}

/** Owner mobile + point-of-contact lines, each with call / WhatsApp / copy. */
function contactLines(v) {
  const lines = [];
  if (v.phone) lines.push(`<div class="contact-line"><span class="contact-k">Owner</span><span>${esc(v.phone)}</span>${phoneActions(v.phone, { label: 'owner' })}</div>`);
  if (v.poc_name || v.poc_phone) {
    lines.push(`<div class="contact-line"><span class="contact-k">Contact</span><span>${esc(v.poc_name || '')}${v.poc_name && v.poc_phone ? ' · ' : ''}${esc(v.poc_phone || '')}</span>${phoneActions(v.poc_phone, { label: v.poc_name || 'contact' })}</div>`);
  }
  if (!lines.length) return '<div class="muted small">No contact numbers</div>';
  return `<div class="contacts">${lines.join('')}</div>`;
}

/** Card footer buttons: WhatsApp + Call the point of contact if there is one, otherwise the owner. */
function mainContactButtons(v) {
  const phone = v.poc_phone || v.phone;
  if (!phone) return '';
  const who = v.poc_phone ? (v.poc_name || 'contact') : 'owner';
  const wa = waHref(phone);
  return `${wa ? `<a class="btn btn-sm btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-stop title="WhatsApp ${esc(who)}">${ICONS.whatsapp} WhatsApp</a>` : ''}
    <a class="btn btn-sm" href="${esc(telHref(phone))}" data-stop title="Call ${esc(who)}">${ICONS.phone} Call</a>`;
}

function vendorCard(v, q) {
  return `
    <article class="card vendor-card" data-id="${v.id}" tabindex="0" aria-label="${esc(v.name)}">
      <div class="vendor-card-head">
        <h3>${esc(v.name)}</h3>
        ${isAdmin() && Number(v.outstanding) > 0 ? `<span class="owed">Owed <b>${inr(v.outstanding)}</b></span>` : ''}
      </div>
      ${v.address ? `<div class="vendor-meta"><span>${ICONS.pin}${esc(v.address)}</span></div>` : ''}
      ${contactLines(v)}
      ${offeringsHtml(v.offerings, q)}
      <div class="vendor-card-foot">
        <div style="display:flex;gap:6px">${mainContactButtons(v)}</div>
        <div style="display:flex;gap:4px">
          <button type="button" class="btn btn-sm btn-ghost" data-view>${ICONS.eye} Details</button>
          <button type="button" class="btn btn-sm" data-edit>${ICONS.edit} Edit</button>
        </div>
      </div>
    </article>`;
}

results.addEventListener('click', (e) => {
  const card = e.target.closest('.vendor-card');
  if (!card) return;
  if (e.target.closest('[data-stop]')) return;
  const copy = e.target.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy);
  if (e.target.closest('[data-edit]')) return editVendor(card.dataset.id);
  openDetails(card.dataset.id);
});
results.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('vendor-card')) openDetails(e.target.dataset.id);
});

/* ---------------- Actions ---------------- */
async function refreshAll() {
  tax = await fetchTaxonomy();
  await search();
}

async function addVendor() {
  if (await openVendorForm()) refreshAll();
}

async function editVendor(id) {
  if (await openVendorForm(id)) refreshAll();
}

async function openDetails(id) {
  const m = openModal({ title: 'Vendor details', body: loadingBlock(), wide: true });
  const admin = isAdmin();
  const [v, p] = await Promise.all([
    sb.from('vendor_directory').select('*').eq('id', id).maybeSingle(),
    // finance: admins only
    admin
      ? sb.from('payables_view').select('id, description, total_amount, amount_paid, balance, status, transaction_date')
        .eq('vendor_id', id).order('transaction_date', { ascending: false }).limit(10)
      : { data: [], error: null },
  ]);
  if (v.error || p.error || !v.data) {
    m.body.innerHTML = `<div class="alert alert-error">${esc(v.error || p.error ? errorMessage(v.error || p.error) : 'Vendor not found.')}</div>`;
    return;
  }
  const vendor = v.data;
  m.dialog.querySelector('h2').textContent = vendor.name;
  m.body.innerHTML = `
    <dl class="dl">
      <dt>Company</dt><dd><b>${esc(vendor.name)}</b></dd>
      <dt>Owner mobile</dt><dd>${vendor.phone ? `${esc(vendor.phone)} ${phoneActions(vendor.phone, { label: 'owner' })}` : '<span class="muted">—</span>'}</dd>
      <dt>Contact person</dt><dd>${esc(vendor.poc_name || '') || '<span class="muted">—</span>'}</dd>
      <dt>Contact number</dt><dd>${vendor.poc_phone ? `${esc(vendor.poc_phone)} ${phoneActions(vendor.poc_phone, { label: vendor.poc_name || 'contact' })}` : '<span class="muted">—</span>'}</dd>
      <dt>Address</dt><dd style="white-space:pre-wrap">${esc(vendor.address || '') || '<span class="muted">—</span>'}</dd>
      ${admin ? `<dt>Outstanding</dt><dd>${Number(vendor.outstanding) > 0 ? `<b style="color:var(--danger)">${inr(vendor.outstanding)}</b> still to pay` : '<span class="muted">Nothing owed</span>'}</dd>` : ''}
      <dt>Added</dt><dd>${fmtDate(vendor.created_at)}</dd>
    </dl>
    <div class="form-section">
      <div class="form-section-head"><h4>Product categories &amp; brands</h4></div>
      ${offeringsHtml(vendor.offerings, '')}
    </div>
    ${admin ? `<div class="form-section">
      <div class="form-section-head"><h4>Recent payables</h4><a href="money.html#payables" class="small">Open Money Manager →</a></div>
      ${p.data.length ? `<div class="table-wrap"><table class="table"><tbody>${p.data.map((r) => `
        <tr class="clickable" data-href="money.html#payables/${r.id}">
          <td><div class="cell-title">${esc(r.description)}</div><div class="cell-sub">${fmtDate(r.transaction_date)}</div></td>
          <td>${statusBadge(r.status)}</td>
          <td class="num">${inr(r.balance)}<div class="cell-sub">of ${inr(r.total_amount)}</div></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="muted small">No payables recorded for this vendor.</div>'}
    </div>` : ''}`;
  m.body.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) copyText(copy.dataset.copy);
    const tr = e.target.closest('tr[data-href]');
    if (tr) location.href = tr.dataset.href;
  });
  const foot = h(`<div class="modal-foot">
      ${admin ? `<button type="button" class="btn btn-ghost" data-del style="color:var(--danger)">${ICONS.trash} Delete</button>` : ''}
      <span class="spacer"></span>
      ${mainContactButtons(vendor).replace(/ btn-sm/g, '')}
      <button type="button" class="btn btn-primary" data-edit>${ICONS.edit} Edit vendor</button>
    </div>`);
  m.dialog.querySelector('.modal-inner').appendChild(foot);
  foot.querySelector('[data-edit]').addEventListener('click', async () => {
    m.close();
    await editVendor(id);
  });
  foot.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (p.data.length) {
      toast(`${vendor.name} has payable records and cannot be deleted.`, 'error');
      return;
    }
    const ok = await confirmDialog({
      title: 'Delete vendor?',
      message: `“${vendor.name}” and its product categories/brands will be removed from the shared directory. This cannot be undone.`,
      confirmText: 'Delete vendor', danger: true,
    });
    if (!ok) return;
    const { error } = await sb.from('vendors').delete().eq('id', id);
    if (error) return toast(errorMessage(error), 'error');
    toast('Vendor deleted', 'success');
    m.close();
    refreshAll();
  });
}

$('#add-vendor').addEventListener('click', addVendor);

/* ---------------- Boot ---------------- */
results.innerHTML = loadingBlock();
try {
  tax = await fetchTaxonomy();
} catch (e) {
  results.innerHTML = `<div class="alert alert-error">${esc(errorMessage(e))}</div>`;
  throw e;
}
const params = new URLSearchParams(location.search);
if (params.get('q')) { filters.q = params.get('q'); $('#q').value = filters.q; }
if (params.get('category')) { catCombo.setValue(params.get('category')); filters.category = catCombo.value(); }
if (params.get('brand')) { brandCombo.setValue(params.get('brand')); filters.brand = brandCombo.value(); }
search();
