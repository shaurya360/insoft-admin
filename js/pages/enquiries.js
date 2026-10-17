import { initShell } from '../layout.js';
import { sb, isAdmin } from '../supabase.js';
import {
  ICONS, esc, $, fmtDate, toast, errorMessage, loadingBlock, emptyState, debounce, phoneActions, copyText, confirmDialog,
} from '../ui.js';
import { fetchAll, openClientForm } from '../entities.js';

await initShell('enquiries');

$('#search-wrap').insertAdjacentHTML('afterbegin', ICONS.search);
const list = $('#list');
const countEl = $('#count');
let rows = [];

const STATUS_LABEL = { new: 'New', contacted: 'Contacted', closed: 'Closed' };
const STATUS_CLASS = { new: 'badge-unpaid', contacted: 'badge-partial', closed: 'badge-paid' };

const fmtWhen = (ts) => {
  const d = new Date(ts);
  return `${fmtDate(ts.slice(0, 10))}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
};

async function load() {
  list.innerHTML = loadingBlock();
  try {
    rows = await fetchAll(() => sb.from('enquiries').select('*').order('created_at', { ascending: false }));
    render();
  } catch (e) {
    list.innerHTML = `<div class="alert alert-error">${esc(errorMessage(e))}</div>`;
  }
}

function render() {
  const status = $('#status').value;
  const q = $('#q').value.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (status === 'open' ? r.status === 'closed' : status && r.status !== status) return false;
    if (q && !`${r.name} ${r.company || ''} ${r.phone || ''} ${r.email || ''} ${r.topic || ''} ${r.message}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const newCount = rows.filter((r) => r.status === 'new').length;
  countEl.textContent = `${shown.length} shown · ${newCount} new`;
  if (!rows.length) {
    list.innerHTML = `<div class="card">${emptyState({ icon: 'inbox', title: 'No enquiries yet', text: 'Messages sent from the website contact form will appear here.' })}</div>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = emptyState({ icon: 'search', title: 'No matching enquiries' });
    return;
  }
  list.innerHTML = `<div class="enquiries">${shown.map((r) => `
    <article class="card enquiry" data-id="${r.id}">
      <div class="enquiry-head">
        <div>
          <h3>${esc(r.name)}${r.company ? ` <span class="muted">· ${esc(r.company)}</span>` : ''}</h3>
          <div class="small muted">${fmtWhen(r.created_at)}${r.topic ? ` · ${esc(r.topic)}` : ''}</div>
        </div>
        <span class="badge ${STATUS_CLASS[r.status]}">${STATUS_LABEL[r.status]}</span>
      </div>
      <p class="enquiry-msg">${esc(r.message)}</p>
      <div class="enquiry-contact">
        ${r.phone ? `<span>${esc(r.phone)} ${phoneActions(r.phone, { label: r.name })}</span>` : ''}
        ${r.email ? `<span><a href="mailto:${esc(r.email)}">${esc(r.email)}</a> <button type="button" class="icon-btn" data-copy="${esc(r.email)}" title="Copy email" aria-label="Copy email">${ICONS.copy}</button></span>` : ''}
      </div>
      <div class="enquiry-foot">
        <label class="small muted" for="st-${r.id}">Status</label>
        <select class="input enquiry-status" id="st-${r.id}" data-status>
          ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${v === r.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-client>${ICONS.plus} Save as client</button>
        ${isAdmin() ? `<button type="button" class="icon-btn" data-delete title="Delete enquiry" aria-label="Delete enquiry">${ICONS.trash}</button>` : ''}
      </div>
    </article>`).join('')}</div>`;
}

list.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  const id = sel.closest('[data-id]').dataset.id;
  sel.disabled = true;
  const { error } = await sb.from('enquiries').update({ status: sel.value }).eq('id', id);
  sel.disabled = false;
  if (error) { toast(errorMessage(error), 'error'); return; }
  rows.find((r) => r.id === id).status = sel.value;
  toast(`Marked as ${STATUS_LABEL[sel.value].toLowerCase()}`, 'success');
  render();
});

list.addEventListener('click', async (e) => {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const r = rows.find((x) => x.id === card.dataset.id);
  const copy = e.target.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy);
  if (e.target.closest('[data-client]')) {
    const saved = await openClientForm(null, { name: r.company || r.name, phone: r.phone || '', address: '' });
    if (saved) toast(`${saved.name} added to clients — available in quotations`, 'success');
    return;
  }
  if (e.target.closest('[data-delete]')) {
    const ok = await confirmDialog({
      title: 'Delete enquiry?',
      message: `The enquiry from ${r.name} will be permanently deleted.`,
      confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
    const { error } = await sb.from('enquiries').delete().eq('id', r.id);
    if (error) return toast(errorMessage(error), 'error');
    rows = rows.filter((x) => x.id !== r.id);
    toast('Enquiry deleted', 'success');
    render();
  }
});

$('#q').addEventListener('input', debounce(render, 150));
$('#status').addEventListener('change', render);
load();
