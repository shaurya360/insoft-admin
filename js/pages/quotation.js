// Admin integration for the existing quotation generator (quotation.html).
// The generator's own functions (addItem, calculateGST, generatePreview,
// togglePaymentDays, downloadPDF) are reused as-is; this module only adds
// authentication, shared client/vendor selection and saving to Supabase.
import { sb, requireAdmin, logout } from '../supabase.js';
import {
  ICONS, esc, inr, fmtDate, todayISO, openModal, confirmDialog, createCombobox, toast, errorMessage,
  loadingBlock, emptyState, setLoading, debounce,
} from '../ui.js';
import { fetchClients, fetchVendors, openClientForm, openVendorForm } from '../entities.js';

await requireAdmin();
let clients = [];
let vendors = [];
let partiesLoading = true;
// Start loading the shared client/vendor lists straight away.
const partiesReady = Promise.all([fetchClients(), fetchVendors()]).then(([c, v]) => { clients = c; vendors = v; });
if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));

const $id = (id) => document.getElementById(id);
// openedSaved: editing a document opened from "Saved documents" (its ref number is kept on re-download).
const state = { id: null, partyType: null, partyId: null, dirty: false, saving: false, openedSaved: false };

/* ---------------- Top bar ---------------- */
$id('qa-dashboard').innerHTML = `${ICONS.home}<span class="lbl">Dashboard</span>`;
$id('qa-saved').innerHTML = `${ICONS.file}<span class="lbl">Saved documents</span>`;
$id('qa-new').innerHTML = `${ICONS.plus}<span class="lbl">New</span>`;
$id('qa-logout').innerHTML = `${ICONS.logout}<span class="lbl">Log out</span>`;
$id('qa-logout').addEventListener('click', async () => {
  if (state.dirty && !(await confirmDialog({ title: 'Log out?', message: 'You have unsaved changes on this document.', confirmText: 'Log out anyway', danger: true }))) return;
  state.dirty = false;
  logout();
});
$id('qa-saved').addEventListener('click', openSavedList);

function setStatus() {
  $id('qa-status').textContent = state.id
    ? `Saved as ${$id('refNo').value}${state.dirty ? ' · unsaved changes' : ''}`
    : state.dirty ? 'Not saved yet' : '';
}

$id('app-container').addEventListener('input', () => { state.dirty = true; setStatus(); });
$id('app-container').addEventListener('change', () => { state.dirty = true; setStatus(); });
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------------- Shared client / vendor picker ---------------- */
const isPO = () => $id('docType').value === 'PURCHASE ORDER';

function partyOptions() {
  const c = clients.map((x) => ({ value: 'client:' + x.id, label: x.name, sub: [x.phone, x.address].filter(Boolean).join(' · '), group: 'Clients' }));
  const v = vendors.map((x) => ({ value: 'vendor:' + x.id, label: x.name, sub: [x.phone, x.address].filter(Boolean).join(' · '), group: 'Vendors' }));
  return isPO() ? [...v, ...c] : [...c, ...v];
}

// The generator's own "Company / Person Name" field doubles as the search box:
// typing shows matching saved clients/vendors; picking one fills name + address.
const picker = createCombobox($id('clientName'), {
  plain: true,
  freeText: true,
  placeholder: 'Type to search saved clients, or enter any name',
  getOptions: partyOptions,
  isLoading: () => partiesLoading,
  onChange: (o) => {
    if (!o) return;
    const [type, id] = o.value.split(':');
    const rec = (type === 'client' ? clients : vendors).find((x) => x.id === id);
    linkParty(type, id);
    $id('clientName').value = rec.name;
    $id('clientAddress').value = rec.address || '';
    state.dirty = true;
    generatePreview();
    setStatus();
  },
});

function linkParty(type, id) {
  state.partyType = type;
  state.partyId = id;
  renderPartyStatus();
}

function renderPartyStatus() {
  const el = $id('qa-party-status');
  const list = state.partyType === 'client' ? clients : vendors;
  const rec = state.partyId && list.find((x) => x.id === state.partyId);
  if (rec) {
    el.innerHTML = `<span>Linked to ${state.partyType}: <b>${esc(rec.name)}</b></span>
      <button type="button" class="qa-link" data-unlink>Unlink</button>`;
  } else {
    const name = $id('clientName').value.trim();
    const kind = isPO() ? 'vendor' : 'client';
    el.innerHTML = name
      ? `<span>Not linked to a saved record.</span> <button type="button" class="qa-link" data-save-party>Save “${esc(name)}” as a new ${kind}</button>`
      : '<span>Or type the details manually below.</span>';
  }
}

$id('qa-party-status').addEventListener('click', async (e) => {
  if (e.target.closest('[data-unlink]')) {
    state.partyType = state.partyId = null;
    picker.clear();
    state.dirty = true;
    renderPartyStatus();
    setStatus();
  } else if (e.target.closest('[data-save-party]')) {
    const prefill = { name: $id('clientName').value.trim(), address: $id('clientAddress').value.trim() };
    const kind = isPO() ? 'vendor' : 'client';
    const saved = kind === 'vendor' ? await openVendorForm(null, prefill) : await openClientForm(null, prefill);
    if (!saved) return;
    await loadParties();
    linkParty(kind, saved.id);
    picker.setValue(`${kind}:${saved.id}`);
    $id('clientName').value = saved.name;
    $id('clientAddress').value = saved.address || '';
    state.dirty = true;
    generatePreview();
    setStatus();
  }
});
$id('clientName').addEventListener('input', debounce(renderPartyStatus, 200));
$id('docType').addEventListener('change', renderPartyStatus);

async function loadParties() {
  [clients, vendors] = await Promise.all([fetchClients(), fetchVendors()]);
}

/* ---------------- Reference number ---------------- */
// Continues from the higher of: the last saved document in the database and
// the serial the generator stored locally on PDF download (existing behaviour).
async function suggestRef() {
  const year = new Date().getFullYear();
  const local = parseInt(localStorage.getItem('insoft_last_serial') || '0', 10) || 0;
  const { data, error } = await sb.rpc('next_quotation_serial', { p_year: year });
  const next = Math.max(error ? 1 : data, local + 1);
  return `INS/${year}/${String(next).padStart(3, '0')}`;
}

/* ---------------- Read / write the generator's form ---------------- */
const round2 = (n) => Math.round(n * 100) / 100;

function collect() {
  const items = [...document.querySelectorAll('#items-container .input-row')].map((row) => ({
    name: row.querySelector('.item-name').value,
    qty: row.querySelector('.item-qty').value,
    ex_gst: row.querySelector('.item-exgst').value,
    inc_gst: row.querySelector('.item-incgst').value,
  }));
  // Same arithmetic as generatePreview()
  const subtotal = items.reduce((s, it) => s + (parseFloat(it.ex_gst) || 0) * (parseFloat(it.qty) || 0), 0);
  const gst = subtotal * 0.18;
  return {
    ref_no: $id('refNo').value.trim(),
    doc_type: $id('docType').value,
    client_id: state.partyType === 'client' ? state.partyId : null,
    vendor_id: state.partyType === 'vendor' ? state.partyId : null,
    party_name: $id('clientName').value.trim() || null,
    party_address: $id('clientAddress').value.trim() || null,
    doc_date: $id('docDate').value,
    items,
    terms: {
      delivery_days: $id('tc-delivery').value,
      validity_days: $id('tc-validity').value,
      payment_type: $id('tc-payment-type').value,
      payment_days: $id('tc-payment-days').value,
    },
    subtotal: round2(subtotal),
    gst_amount: round2(gst),
    grand_total: round2(subtotal + gst),
  };
}

function fill(q, { asCopy = false, ref = null } = {}) {
  $id('docType').value = q.doc_type;
  $id('clientName').value = q.party_name || '';
  $id('clientAddress').value = q.party_address || '';
  $id('refNo').value = asCopy ? ref : q.ref_no;
  $id('docDate').value = asCopy ? todayISO() : q.doc_date;
  const container = $id('items-container');
  container.innerHTML = '';
  const items = Array.isArray(q.items) && q.items.length ? q.items : [{}];
  for (const it of items) {
    addItem();
    const row = container.lastElementChild;
    row.querySelector('.item-name').value = it.name ?? '';
    row.querySelector('.item-qty').value = it.qty ?? 1;
    row.querySelector('.item-exgst').value = it.ex_gst ?? '';
    row.querySelector('.item-incgst').value = it.inc_gst ?? '';
  }
  const t = q.terms || {};
  if (t.delivery_days != null) $id('tc-delivery').value = t.delivery_days;
  if (t.validity_days != null) $id('tc-validity').value = t.validity_days;
  if (t.payment_type) $id('tc-payment-type').value = t.payment_type;
  if (t.payment_days != null) $id('tc-payment-days').value = t.payment_days;
  togglePaymentDays();

  state.partyType = q.client_id ? 'client' : q.vendor_id ? 'vendor' : null;
  state.partyId = q.client_id || q.vendor_id || null;
  if (state.partyId) picker.setValue(`${state.partyType}:${state.partyId}`);
  $id('clientName').value = q.party_name || ''; // keep the printed name, even if the record was renamed since
  renderPartyStatus();
  generatePreview();
}

/* ---------------- Save ---------------- */
async function save({ auto = false } = {}) {
  if (state.saving) return false;
  generatePreview();
  const row = collect();
  if (!row.ref_no) { toast('Enter a reference number before saving.', 'error'); return false; }
  if (!row.doc_date) { toast('Enter the document date before saving.', 'error'); return false; }

  state.saving = true;
  const btn = $id('qa-save');
  setLoading(btn, true);
  try {
    let res = state.id
      ? await sb.from('quotations').update(row).eq('id', state.id).select('id').single()
      : await sb.from('quotations').insert(row).select('id').single();
    if (res.error?.code === '23505') {
      const ok = await confirmDialog({
        title: 'Reference number already used',
        message: `Another saved document already uses ${row.ref_no}. Replace that saved document with this one?`
          + (auto ? ' (Choosing Cancel still downloads the PDF, but does not save it.)' : ''),
        confirmText: 'Replace saved document', danger: true,
      });
      if (!ok) return false;
      res = await sb.from('quotations').update(row).eq('ref_no', row.ref_no).select('id').single();
    }
    if (res.error) throw res.error;
    state.id = res.data.id;
    state.dirty = false;
    history.replaceState(null, '', 'quotation.html?id=' + state.id);
    setStatus();
    toast(`${row.doc_type === 'QUOTATION' ? 'Quotation' : 'Purchase order'} ${row.ref_no} saved`, 'success');
    return true;
  } catch (e) {
    toast('Could not save: ' + errorMessage(e), 'error');
    return false;
  } finally {
    state.saving = false;
    setLoading(btn, false);
  }
}

$id('qa-save').addEventListener('click', () => save());

// The generator hides #app-container while html2pdf renders and shows it again when done.
function pdfFinished() {
  const box = $id('app-container');
  return new Promise((resolve) => {
    const check = () => box.style.display !== 'none';
    const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); clearTimeout(t); resolve(); } });
    const t = setTimeout(() => { obs.disconnect(); resolve(); }, 60000);
    obs.observe(box, { attributes: true, attributeFilter: ['style'] });
  });
}

// Start a new document with the next reference number, keeping the current
// contents so a similar document can be made quickly.
async function advanceToNextRef() {
  const issued = $id('refNo').value;
  state.id = null;
  state.openedSaved = false;
  $id('refNo').value = await suggestRef();
  $id('docDate').value = todayISO();
  history.replaceState(null, '', 'quotation.html');
  state.dirty = false;
  generatePreview();
  setStatus();
  toast(`${issued} downloaded. Next document number: ${$id('refNo').value}`, 'success', 6000);
}

// Download PDF = save + the generator's existing PDF logic (unchanged), then move
// on to the next reference number for new documents.
const originalDownloadPDF = window.downloadPDF;
window.downloadPDF = async function () {
  try { await save({ auto: true }); } catch { /* never block the PDF */ }
  const done = pdfFinished();
  const result = originalDownloadPDF.apply(this, arguments);
  if (!state.openedSaved) done.then(advanceToNextRef);
  return result;
};

/* ---------------- Saved documents ---------------- */
async function openSavedList() {
  const m = openModal({ title: 'Saved documents', subtitle: 'Quotations and purchase orders saved from this generator', body: loadingBlock(), wide: true });
  const { data, error } = await sb.from('quotations')
    .select('id, ref_no, doc_type, party_name, doc_date, grand_total, created_at')
    .order('doc_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
  if (error) { m.body.innerHTML = `<div class="alert alert-error">${esc(errorMessage(error))}</div>`; return; }
  if (!data.length) { m.body.innerHTML = emptyState({ icon: 'file', title: 'No saved documents yet', text: 'Use Save or Download PDF to keep a copy here.' }); return; }

  m.body.innerHTML = `
    <div class="search" style="margin-bottom:12px">${ICONS.search}<input class="input" type="search" placeholder="Search by reference or client" data-q></div>
    <div class="table-wrap"><table class="table"><thead><tr>
      <th>Reference</th><th>Party</th><th>Date</th><th class="th-num">Grand total</th><th class="sr-only">Actions</th>
    </tr></thead><tbody data-rows></tbody></table></div>`;
  const tbody = m.body.querySelector('[data-rows]');
  const draw = (q = '') => {
    const rows = data.filter((r) => !q || `${r.ref_no} ${r.party_name || ''}`.toLowerCase().includes(q.toLowerCase()));
    tbody.innerHTML = rows.length ? rows.map((r) => `
      <tr data-id="${r.id}">
        <td><div class="cell-title">${esc(r.ref_no)}</div><div class="cell-sub">${r.doc_type === 'QUOTATION' ? 'Quotation' : 'Purchase order'}</div></td>
        <td>${esc(r.party_name || '') || '<span class="muted">—</span>'}</td>
        <td class="nowrap">${fmtDate(r.doc_date)}</td>
        <td class="num">${inr(r.grand_total)}</td>
        <td><div class="row-actions">
          <a class="btn btn-sm" href="quotation.html?id=${r.id}">Open</a>
          <a class="btn btn-sm btn-ghost" href="quotation.html?copy=${r.id}" title="Start a new document from this one">Duplicate</a>
          <button type="button" class="icon-btn" data-del title="Delete" aria-label="Delete">${ICONS.trash}</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="5" class="muted">No matches</td></tr>';
  };
  draw();
  m.body.querySelector('[data-q]').addEventListener('input', (e) => draw(e.target.value));
  tbody.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-del]')) return;
    const id = e.target.closest('tr').dataset.id;
    const r = data.find((x) => x.id === id);
    const ok = await confirmDialog({ title: 'Delete saved document?', message: `${r.ref_no}${r.party_name ? ' for ' + r.party_name : ''} will be permanently deleted. Downloaded PDFs are not affected.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    const { error: delErr } = await sb.from('quotations').delete().eq('id', id);
    if (delErr) return toast(errorMessage(delErr), 'error');
    data.splice(data.indexOf(r), 1);
    if (state.id === id) { state.id = null; history.replaceState(null, '', 'quotation.html'); setStatus(); }
    toast('Deleted', 'success');
    draw(m.body.querySelector('[data-q]').value);
  });
}

/* ---------------- Boot ---------------- */
try {
  await partiesReady;
} catch (e) {
  toast('Could not load clients/vendors: ' + errorMessage(e), 'error');
} finally {
  partiesLoading = false;
  picker.refresh();
}

const params = new URLSearchParams(location.search);
const openId = params.get('id') || params.get('copy');
if (openId) {
  const { data, error } = await sb.from('quotations').select('*').eq('id', openId).maybeSingle();
  if (error || !data) {
    toast(error ? errorMessage(error) : 'Saved document not found.', 'error');
    history.replaceState(null, '', 'quotation.html');
    $id('refNo').value = await suggestRef();
  } else if (params.get('copy')) {
    fill(data, { asCopy: true, ref: await suggestRef() });
    history.replaceState(null, '', 'quotation.html');
    state.dirty = true;
  } else {
    fill(data);
    state.id = data.id;
    state.openedSaved = true;
  }
} else {
  $id('refNo').value = await suggestRef();
}
renderPartyStatus();
generatePreview();
setStatus();
document.body.dataset.qaReady = '1';
