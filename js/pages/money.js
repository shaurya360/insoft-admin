import { initShell, setActiveSub } from '../layout.js';
import { sb } from '../supabase.js';
import {
  ICONS, esc, inr, fmtDate, todayISO, parseAmount, toPaise, fromPaise, sumMoney, statusBadge, h, $, $$,
  openModal, confirmDialog, createCombobox, setLoading, toast, errorMessage, loadingBlock, emptyState,
  debounce, copyText, phoneActions,
} from '../ui.js';
import { fetchAll, fetchVendors, fetchClients, openVendorForm, openClientForm } from '../entities.js';

await initShell('money');

const KINDS = {
  payables: {
    view: 'payables_view', table: 'payables', payTable: 'payable_payments', fk: 'payable_id',
    partyKey: 'vendor_id', party: 'Vendor', rpc: 'create_payable', rpcParty: 'p_vendor_id',
    noun: 'payable', paid: 'Paid', total: 'Total payable', payVerb: 'Record payment', payNoun: 'payment',
    newLabel: 'New payable',
  },
  receivables: {
    view: 'receivables_view', table: 'receivables', payTable: 'receivable_payments', fk: 'receivable_id',
    partyKey: 'client_id', party: 'Client', rpc: 'create_receivable', rpcParty: 'p_client_id',
    noun: 'receivable', paid: 'Received', total: 'Total receivable', payVerb: 'Record receipt', payNoun: 'receipt',
    newLabel: 'New receivable',
  },
};

const state = {
  tab: 'payables',
  loaded: false,
  data: { payables: [], receivables: [] },
  vendors: [],
  clients: [],
  filters: {
    payables: { q: '', status: '', party: null, from: '', to: '' },
    receivables: { q: '', status: '', party: null, from: '', to: '' },
    clients: { q: '' },
  },
};

const panel = $('#panel');
$('[data-action="add-vendor"]').innerHTML = `${ICONS.plus} Add New Vendor`;
$('[data-action="add-client"]').innerHTML = `${ICONS.plus} Add New Client`;

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */
async function loadAll() {
  const [payables, receivables, vendors, clients] = await Promise.all([
    fetchAll(() => sb.from('payables_view').select('*').order('transaction_date', { ascending: false }).order('created_at', { ascending: false })),
    fetchAll(() => sb.from('receivables_view').select('*').order('transaction_date', { ascending: false }).order('created_at', { ascending: false })),
    fetchVendors(),
    fetchClients(),
  ]);
  Object.assign(state, { vendors, clients, loaded: true });
  state.data = { payables, receivables };
  renderSummary();
}

async function reload() {
  try {
    await loadAll();
    renderPanel(false);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function renderSummary() {
  const { payables, receivables } = state.data;
  $('[data-sum="pay-out"]').textContent = inr(sumMoney(payables, 'balance'));
  $('[data-sum="pay-paid"]').textContent = inr(sumMoney(payables, 'amount_paid'));
  $('[data-sum="rec-out"]').textContent = inr(sumMoney(receivables, 'balance'));
  $('[data-sum="rec-paid"]').textContent = inr(sumMoney(receivables, 'amount_paid'));
  $('[data-count="payables"]').textContent = payables.length;
  $('[data-count="receivables"]').textContent = receivables.length;
  $('[data-count="clients"]').textContent = state.clients.length;
}

const partiesFor = (kind) => (kind === 'payables' ? state.vendors : state.clients);
const partyOptions = (kind) => partiesFor(kind).map((p) => ({ value: p.id, label: p.name, sub: p.phone || '' }));

/* ------------------------------------------------------------------ */
/* Routing (#payables, #receivables/<id>, #clients)                    */
/* ------------------------------------------------------------------ */
function parseHash() {
  const [tab, id] = location.hash.replace(/^#/, '').split('/');
  return { tab: ['payables', 'receivables', 'clients'].includes(tab) ? tab : 'payables', id };
}

function route() {
  const { tab, id } = parseHash();
  if (tab !== state.tab || !panel.dataset.rendered) {
    state.tab = tab;
    renderPanel(true);
  }
  if (id && KINDS[tab]) openRecord(tab, id);
}

window.addEventListener('hashchange', route);
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */
function renderPanel(rebuildToolbar) {
  $$('[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
    b.setAttribute('aria-selected', b.dataset.tab === state.tab);
  });
  setActiveSub(state.tab);
  panel.dataset.rendered = '1';
  if (!state.loaded) { panel.innerHTML = loadingBlock(); return; }
  if (state.tab === 'clients') return renderClients(rebuildToolbar);
  return renderRecords(state.tab, rebuildToolbar);
}

function renderRecords(kind, rebuildToolbar) {
  const K = KINDS[kind];
  const f = state.filters[kind];
  if (rebuildToolbar || !panel.querySelector('[data-records]')) {
    panel.innerHTML = `
      <div class="toolbar">
        <div class="field grow"><label for="f-q">Search</label>
          <div class="search">${ICONS.search}<input class="input" id="f-q" type="search" placeholder="Name, description, phone, notes" value="${esc(f.q)}"></div>
        </div>
        <div class="field"><label for="f-party">${K.party}</label><input id="f-party" type="text"></div>
        <div class="field" style="flex:0 1 160px"><label for="f-status">Status</label>
          <select class="input" id="f-status">
            <option value="">All statuses</option>
            <option value="outstanding">Outstanding (not fully paid)</option>
            <option value="Unpaid">Unpaid</option>
            <option value="Partially Paid">Partially Paid</option>
            <option value="Paid">Paid</option>
          </select>
        </div>
        <div class="field" style="flex:0 1 150px"><label for="f-from">From date</label><input class="input" id="f-from" type="date" value="${esc(f.from)}"></div>
        <div class="field" style="flex:0 1 150px"><label for="f-to">To date</label><input class="input" id="f-to" type="date" value="${esc(f.to)}"></div>
        <button type="button" class="btn" data-clear>Clear</button>
        <button type="button" class="btn btn-primary" data-new>${ICONS.plus} ${K.newLabel}</button>
      </div>
      <div class="card"><div data-records></div></div>`;
    $('#f-status').value = f.status;
    const combo = createCombobox($('#f-party'), {
      placeholder: `All ${K.party.toLowerCase()}s`,
      getOptions: () => partyOptions(kind),
      onChange: (o) => { f.party = o?.value ?? null; drawTable(kind); },
    });
    if (f.party) combo.setValue(f.party);
    $('#f-q').addEventListener('input', debounce((e) => { f.q = e.target.value; drawTable(kind); }, 150));
    $('#f-status').addEventListener('change', (e) => { f.status = e.target.value; drawTable(kind); });
    $('#f-from').addEventListener('change', (e) => { f.from = e.target.value; drawTable(kind); });
    $('#f-to').addEventListener('change', (e) => { f.to = e.target.value; drawTable(kind); });
    panel.querySelector('[data-clear]').addEventListener('click', () => {
      Object.assign(f, { q: '', status: '', party: null, from: '', to: '' });
      renderRecords(kind, true);
    });
    panel.querySelector('[data-new]').addEventListener('click', () => openNewRecord(kind));
  }
  drawTable(kind);
}

function filtered(kind) {
  const f = state.filters[kind];
  const q = f.q.trim().toLowerCase();
  return state.data[kind].filter((r) => {
    if (f.party && r[KINDS[kind].partyKey] !== f.party) return false;
    if (f.status === 'outstanding' ? r.status === 'Paid' : f.status && r.status !== f.status) return false;
    if (f.from && r.transaction_date < f.from) return false;
    if (f.to && r.transaction_date > f.to) return false;
    if (q && !`${r.party_name} ${r.description} ${r.party_phone || ''} ${r.notes || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function drawTable(kind) {
  const K = KINDS[kind];
  const box = panel.querySelector('[data-records]');
  const all = state.data[kind];
  const rows = filtered(kind);
  if (!all.length) {
    box.innerHTML = emptyState({
      icon: 'wallet',
      title: `No ${K.noun}s yet`,
      text: kind === 'payables' ? 'Record money you owe a vendor to start tracking it.' : 'Record money a client owes you to start tracking it.',
      action: `<button type="button" class="btn btn-primary" data-new-empty>${ICONS.plus} ${K.newLabel}</button>`,
    });
    box.querySelector('[data-new-empty]').addEventListener('click', () => openNewRecord(kind));
    return;
  }
  if (!rows.length) {
    box.innerHTML = emptyState({ icon: 'filter', title: 'No matching records', text: 'Try changing or clearing the filters.' });
    return;
  }
  const today = todayISO();
  box.innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${K.party} / description</th><th>Phone</th>
        <th class="th-num">Total</th><th class="th-num">${K.paid}</th><th class="th-num">Balance</th>
        <th>Status</th><th>Dates</th><th class="sr-only">Actions</th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr class="clickable" data-id="${r.id}">
            <td><div class="cell-title">${esc(r.party_name)}</div><div class="cell-sub">${esc(r.description)}</div></td>
            <td class="nowrap">${r.party_phone ? esc(r.party_phone) : '<span class="muted">—</span>'}</td>
            <td class="num">${inr(r.total_amount)}</td>
            <td class="num">${inr(r.amount_paid)}</td>
            <td class="num cell-title">${inr(r.balance)}</td>
            <td>${statusBadge(r.status)}</td>
            <td class="small nowrap">
              <div>${fmtDate(r.transaction_date)}</div>
              ${r.due_date ? `<div class="${r.due_date < today && r.status !== 'Paid' ? 'overdue' : 'muted'}">Due ${fmtDate(r.due_date)}</div>` : ''}
              ${r.last_payment_date ? `<div class="muted">Last ${K.payNoun} ${fmtDate(r.last_payment_date)}</div>` : ''}
            </td>
            <td><div class="row-actions">
              ${r.status !== 'Paid' ? `<button type="button" class="btn btn-sm" data-pay="${r.id}">${K.payVerb}</button>` : ''}
            </div></td>
          </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="2">${rows.length} record${rows.length === 1 ? '' : 's'}${rows.length !== all.length ? ` (of ${all.length})` : ''}</td>
        <td class="num">${inr(sumMoney(rows, 'total_amount'))}</td>
        <td class="num">${inr(sumMoney(rows, 'amount_paid'))}</td>
        <td class="num">${inr(sumMoney(rows, 'balance'))}</td>
        <td colspan="3"></td>
      </tr></tfoot>
    </table></div>`;
  box.querySelector('tbody').addEventListener('click', (e) => {
    const pay = e.target.closest('[data-pay]');
    if (pay) {
      e.stopPropagation();
      const rec = state.data[kind].find((x) => x.id === pay.dataset.pay);
      if (rec) openPayment(kind, rec);
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `${kind}/${tr.dataset.id}`;
  });
}

/* ------------------------------------------------------------------ */
/* Clients tab                                                         */
/* ------------------------------------------------------------------ */
function renderClients(rebuildToolbar) {
  const f = state.filters.clients;
  if (rebuildToolbar || !panel.querySelector('[data-clients]')) {
    panel.innerHTML = `
      <div class="toolbar">
        <div class="field grow"><label for="c-q">Search clients</label>
          <div class="search">${ICONS.search}<input class="input" id="c-q" type="search" placeholder="Name, phone or address" value="${esc(f.q)}"></div>
        </div>
        <button type="button" class="btn btn-primary" data-new-client>${ICONS.plus} Add New Client</button>
      </div>
      <div class="card"><div data-clients></div></div>`;
    $('#c-q').addEventListener('input', debounce((e) => { f.q = e.target.value; drawClients(); }, 150));
    panel.querySelector('[data-new-client]').addEventListener('click', addClient);
  }
  drawClients();
}

function drawClients() {
  const box = panel.querySelector('[data-clients]');
  const q = state.filters.clients.q.trim().toLowerCase();
  const owed = new Map();
  for (const r of state.data.receivables) owed.set(r.client_id, (owed.get(r.client_id) || 0) + toPaise(r.balance));
  const rows = state.clients.filter((c) => !q || `${c.name} ${c.phone || ''} ${c.address || ''}`.toLowerCase().includes(q));
  if (!state.clients.length) {
    box.innerHTML = emptyState({
      icon: 'users', title: 'No clients yet', text: 'Clients you add here are shared with the quotation generator.',
      action: `<button type="button" class="btn btn-primary" data-empty-client>${ICONS.plus} Add New Client</button>`,
    });
    box.querySelector('[data-empty-client]').addEventListener('click', addClient);
    return;
  }
  if (!rows.length) { box.innerHTML = emptyState({ icon: 'search', title: 'No matching clients' }); return; }
  box.innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Client</th><th>Phone</th><th>Address</th><th class="th-num">Outstanding</th><th class="sr-only">Actions</th></tr></thead>
      <tbody>${rows.map((c) => `
        <tr data-id="${c.id}">
          <td class="cell-title">${esc(c.name)}</td>
          <td class="nowrap">${c.phone ? `${esc(c.phone)} ${phoneActions(c.phone, { label: c.name })}` : '<span class="muted">—</span>'}</td>
          <td class="small">${esc(c.address || '') || '<span class="muted">—</span>'}</td>
          <td class="num">${owed.get(c.id) ? `<b>${inr(fromPaise(owed.get(c.id)))}</b>` : '<span class="muted">—</span>'}</td>
          <td><div class="row-actions">
            <button type="button" class="icon-btn" data-receivable title="New receivable" aria-label="New receivable">${ICONS.rupee}</button>
            <button type="button" class="icon-btn" data-edit title="Edit client" aria-label="Edit client">${ICONS.edit}</button>
            <button type="button" class="icon-btn" data-delete title="Delete client" aria-label="Delete client">${ICONS.trash}</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  box.querySelector('tbody').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const client = state.clients.find((c) => c.id === tr.dataset.id);
    if (e.target.closest('[data-copy]')) copyText(e.target.closest('[data-copy]').dataset.copy);
    else if (e.target.closest('[data-edit]')) { if (await openClientForm(client.id)) reload(); }
    else if (e.target.closest('[data-receivable]')) openNewRecord('receivables', client.id);
    else if (e.target.closest('[data-delete]')) deleteClient(client);
  });
}

async function addClient() {
  if (await openClientForm()) reload();
}

async function deleteClient(client) {
  const linked = state.data.receivables.filter((r) => r.client_id === client.id).length;
  if (linked) {
    toast(`${client.name} has ${linked} receivable record${linked === 1 ? '' : 's'} and cannot be deleted.`, 'error');
    return;
  }
  const ok = await confirmDialog({
    title: 'Delete client?',
    message: `“${client.name}” will be removed from the shared client list. Saved quotations keep the printed name. This cannot be undone.`,
    confirmText: 'Delete client', danger: true,
  });
  if (!ok) return;
  const { error } = await sb.from('clients').delete().eq('id', client.id);
  if (error) return toast(errorMessage(error), 'error');
  toast('Client deleted', 'success');
  reload();
}

/* ------------------------------------------------------------------ */
/* New record                                                          */
/* ------------------------------------------------------------------ */
function amountField(id, label, { required = false, value = '' } = {}) {
  return `<div class="field"><label for="${id}" class="${required ? 'req' : ''}">${label}</label>
    <div class="input-prefix"><span>₹</span><input class="input" id="${id}" name="${id}" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(value)}"></div></div>`;
}

function openNewRecord(kind, partyId = null) {
  const K = KINDS[kind];
  const formId = 'rec-form-' + Date.now();
  const form = h(`<form novalidate id="${formId}">
    <div class="form-grid">
      <div class="field span-2">
        <label class="req" for="n-party">${K.party}</label>
        <input id="n-party" type="text">
        <div class="hint">Pick from the shared ${K.party.toLowerCase()} list, or <a href="#" data-add-party>add a new ${K.party.toLowerCase()}</a>.</div>
      </div>
      <div class="field span-2">
        <label class="req" for="description">Description / reference</label>
        <input class="input" id="description" name="description" maxlength="300" placeholder="${kind === 'payables' ? 'e.g. Invoice #4521 — LED panels' : 'e.g. INS/2026/014 — laptops'}">
      </div>
      ${amountField('total', K.total, { required: true })}
      <div class="field"><label class="req" for="txn">Transaction date</label><input class="input" type="date" id="txn" name="txn" value="${todayISO()}"></div>
      <div class="field"><label for="due">Due date</label><input class="input" type="date" id="due" name="due"></div>
      <div></div>
      ${amountField('initial', kind === 'payables' ? 'Initial payment (optional)' : 'Initial amount received (optional)')}
      <div class="field" data-initial-date hidden><label for="initialDate">${kind === 'payables' ? 'Payment' : 'Receipt'} date</label><input class="input" type="date" id="initialDate" name="initialDate" value="${todayISO()}"></div>
      <div class="field span-2"><label for="notes">Notes</label><textarea class="input" id="notes" name="notes" maxlength="2000" rows="2"></textarea></div>
    </div>
    <div class="alert alert-error" data-error hidden style="margin-top:14px"></div>
  </form>`);
  const m = openModal({
    title: kind === 'payables' ? 'New vendor payable' : 'New client receivable',
    subtitle: kind === 'payables' ? 'Money you owe a vendor' : 'Money a client owes you',
    body: form,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
             <button type="submit" form="${formId}" class="btn btn-primary" data-save>Save</button>`,
  });
  const combo = createCombobox(form.querySelector('#n-party'), {
    placeholder: `Search ${K.party.toLowerCase()}s…`,
    getOptions: () => partyOptions(kind),
  });
  if (partyId) combo.setValue(partyId);
  else form.querySelector('#n-party').focus();

  form.querySelector('[data-add-party]').addEventListener('click', async (e) => {
    e.preventDefault();
    const created = kind === 'payables' ? await openVendorForm() : await openClientForm();
    if (!created) return;
    if (kind === 'payables') state.vendors = await fetchVendors();
    else state.clients = await fetchClients();
    combo.setValue(created.id);
    renderSummary();
  });
  form.initial.addEventListener('input', () => {
    form.querySelector('[data-initial-date]').hidden = !form.initial.value.trim();
  });

  const err = form.querySelector('[data-error]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const party = combo.value();
    const description = form.description.value.replace(/\s+/g, ' ').trim();
    const total = parseAmount(form.total.value);
    const initial = parseAmount(form.initial.value);
    if (!party) return fail(`Select a ${K.party.toLowerCase()}.`, form.querySelector('#n-party'));
    if (!description) return fail('Enter a description or reference.', form.description);
    if (!total || Number.isNaN(total) || total <= 0) return fail('Enter a valid total amount greater than zero (up to 2 decimals).', form.total);
    if (!form.txn.value) return fail('Enter the transaction date.', form.txn);
    if (form.due.value && form.due.value < form.txn.value) return fail('Due date cannot be before the transaction date.', form.due);
    if (Number.isNaN(initial) || (initial !== null && initial < 0)) return fail('Enter a valid initial amount.', form.initial);
    if (initial && toPaise(initial) > toPaise(total)) return fail(`The initial amount cannot be more than the total (${inr(total)}).`, form.initial);

    const btn = m.footer.querySelector('[data-save]');
    setLoading(btn, true);
    const { error } = await sb.rpc(K.rpc, {
      [K.rpcParty]: party,
      p_description: description,
      p_total_amount: total,
      p_transaction_date: form.txn.value,
      p_due_date: form.due.value || null,
      p_notes: form.notes.value.trim() || null,
      p_initial_amount: initial || null,
      p_initial_date: initial ? (form.initialDate.value || form.txn.value) : null,
    });
    setLoading(btn, false);
    if (error) return fail(errorMessage(error));
    toast(`${kind === 'payables' ? 'Payable' : 'Receivable'} saved`, 'success');
    m.close();
    if (state.tab !== kind) location.hash = kind;
    reload();
  });
}

/* ------------------------------------------------------------------ */
/* Record details                                                      */
/* ------------------------------------------------------------------ */
let detailModal = null;

async function openRecord(kind, id) {
  const K = KINDS[kind];
  if (detailModal) detailModal.close();
  const m = openModal({ title: 'Loading…', body: loadingBlock(), wide: true });
  detailModal = m;
  m.onClose(() => {
    if (detailModal === m) detailModal = null;
    if (location.hash.includes('/')) history.replaceState(null, '', '#' + kind);
  });

  const [rec, pays] = await Promise.all([
    sb.from(K.view).select('*').eq('id', id).maybeSingle(),
    sb.from(K.payTable).select('*').eq(K.fk, id).order('payment_date', { ascending: false }).order('created_at', { ascending: false }),
  ]);
  if (detailModal !== m) return;
  if (rec.error || pays.error || !rec.data) {
    m.dialog.querySelector('h2').textContent = 'Record not found';
    m.body.innerHTML = `<div class="alert alert-error">${esc(rec.error || pays.error ? errorMessage(rec.error || pays.error) : 'This record does not exist or was deleted.')}</div>`;
    return;
  }
  const r = rec.data;
  const payments = pays.data;
  const today = todayISO();
  m.dialog.querySelector('h2').textContent = r.description;
  m.body.innerHTML = `
    <dl class="dl">
      <dt>${K.party}</dt><dd><b>${esc(r.party_name)}</b>${r.party_phone ? ` · ${esc(r.party_phone)} ${phoneActions(r.party_phone, { label: r.party_name })}` : ''}</dd>
      <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
      <dt>Transaction date</dt><dd>${fmtDate(r.transaction_date)}</dd>
      <dt>Due date</dt><dd>${r.due_date ? `<span class="${r.due_date < today && r.status !== 'Paid' ? 'overdue' : ''}">${fmtDate(r.due_date)}${r.due_date < today && r.status !== 'Paid' ? ' (overdue)' : ''}</span>` : '<span class="muted">—</span>'}</dd>
      <dt>Notes</dt><dd style="white-space:pre-wrap">${esc(r.notes || '') || '<span class="muted">—</span>'}</dd>
    </dl>
    <div class="mini-stats">
      <div><div class="k">${K.total}</div><div class="v">${inr(r.total_amount)}</div></div>
      <div><div class="k">${K.paid}</div><div class="v">${inr(r.amount_paid)}</div></div>
      <div><div class="k">Remaining balance</div><div class="v" style="color:${Number(r.balance) > 0 ? 'var(--danger)' : 'var(--success)'}">${inr(r.balance)}</div></div>
    </div>
    <div class="form-section-head"><h4>${K.payNoun[0].toUpperCase() + K.payNoun.slice(1)} history</h4></div>
    ${payments.length ? `<ul class="history">${payments.map((p) => `
      <li data-pid="${p.id}">
        <div class="h-main"><div class="cell-title">${inr(p.amount)}</div><div class="cell-sub">${fmtDate(p.payment_date)}${p.notes ? ' · ' + esc(p.notes) : ''}</div></div>
        <button type="button" class="icon-btn" data-del-pay="${p.id}" title="Delete this entry" aria-label="Delete this entry">${ICONS.trash}</button>
      </li>`).join('')}</ul>`
      : `<div class="muted small">No ${K.payNoun}s recorded yet.</div>`}`;

  const foot = h(`<div style="display:contents">
      ${!payments.length ? `<button type="button" class="btn btn-ghost" data-del style="color:var(--danger)">${ICONS.trash} Delete record</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" data-edit>${ICONS.edit} Edit</button>
      ${r.status !== 'Paid' ? `<button type="button" class="btn btn-primary" data-pay>${K.payVerb}</button>` : ''}
    </div>`);
  let footEl = m.dialog.querySelector('.modal-foot');
  if (!footEl) {
    footEl = h('<div class="modal-foot"></div>');
    m.dialog.querySelector('.modal-inner').appendChild(footEl);
  }
  footEl.innerHTML = '';
  footEl.appendChild(foot);

  footEl.querySelector('[data-pay]')?.addEventListener('click', () => openPayment(kind, r, () => openRecord(kind, id)));
  footEl.querySelector('[data-edit]').addEventListener('click', () => openEditRecord(kind, r));
  footEl.querySelector('[data-del]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: `Delete this ${K.noun}?`,
      message: `“${r.description}” for ${r.party_name} (${inr(r.total_amount)}) will be permanently deleted.`,
      confirmText: 'Delete record', danger: true,
    });
    if (!ok) return;
    const { error } = await sb.from(K.table).delete().eq('id', r.id);
    if (error) return toast(errorMessage(error), 'error');
    toast('Record deleted', 'success');
    m.close();
    reload();
  });
  m.body.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) copyText(copy.dataset.copy);
  });
  m.body.querySelectorAll('[data-del-pay]').forEach((b) => b.addEventListener('click', async () => {
    const p = payments.find((x) => x.id === b.dataset.delPay);
    const ok = await confirmDialog({
      title: `Delete this ${K.payNoun}?`,
      message: `The ${K.payNoun} of ${inr(p.amount)} on ${fmtDate(p.payment_date)} will be removed from the history and the balance will increase by the same amount. Only do this to correct a mistake.`,
      confirmText: `Delete ${K.payNoun}`, danger: true,
    });
    if (!ok) return;
    const { error } = await sb.from(K.payTable).delete().eq('id', p.id);
    if (error) return toast(errorMessage(error), 'error');
    toast(`${K.payNoun[0].toUpperCase() + K.payNoun.slice(1)} deleted`, 'success');
    await reload();
    openRecord(kind, id);
  }));
}

/* ------------------------------------------------------------------ */
/* Record a payment / receipt                                          */
/* ------------------------------------------------------------------ */
function openPayment(kind, r, after) {
  const K = KINDS[kind];
  const formId = 'pay-form-' + Date.now();
  const form = h(`<form novalidate id="${formId}">
    <div class="mini-stats" style="margin-top:0">
      <div><div class="k">${K.total}</div><div class="v">${inr(r.total_amount)}</div></div>
      <div><div class="k">${K.paid} so far</div><div class="v">${inr(r.amount_paid)}</div></div>
      <div><div class="k">Remaining</div><div class="v">${inr(r.balance)}</div></div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label class="req" for="amount">Amount</label>
        <div class="input-prefix"><span>₹</span><input class="input" id="amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0"></div>
        <div><button type="button" class="btn btn-sm btn-ghost" data-full style="padding:0 4px;color:var(--primary)">Use full balance (${inr(r.balance)})</button></div>
      </div>
      <div class="field"><label class="req" for="date">Date</label><input class="input" type="date" id="date" name="date" value="${todayISO()}"></div>
      <div class="field span-2"><label for="pnotes">Notes</label><input class="input" id="pnotes" name="pnotes" maxlength="1000" placeholder="e.g. UPI ref 4421, cheque no. 001234"></div>
    </div>
    <div class="alert alert-error" data-error hidden style="margin-top:14px"></div>
  </form>`);
  const m = openModal({
    title: K.payVerb,
    subtitle: `${r.party_name} — ${r.description}`,
    body: form,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
             <button type="submit" form="${formId}" class="btn btn-primary" data-save>Save ${K.payNoun}</button>`,
  });
  form.querySelector('[data-full]').addEventListener('click', () => { form.amount.value = Number(r.balance).toFixed(2).replace(/\.00$/, ''); form.amount.focus(); });

  const err = form.querySelector('[data-error]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const amount = parseAmount(form.amount.value);
    if (!amount || Number.isNaN(amount) || amount <= 0) return fail('Enter an amount greater than zero (up to 2 decimals).', form.amount);
    if (toPaise(amount) > toPaise(r.balance)) return fail(`The amount cannot be more than the remaining balance (${inr(r.balance)}).`, form.amount);
    if (!form.date.value) return fail('Enter the date.', form.date);

    const btn = m.footer.querySelector('[data-save]');
    setLoading(btn, true);
    const { error } = await sb.from(K.payTable).insert({
      [K.fk]: r.id, amount, payment_date: form.date.value, notes: form.pnotes.value.trim() || null,
    });
    setLoading(btn, false);
    if (error) return fail(errorMessage(error));
    const remaining = fromPaise(toPaise(r.balance) - toPaise(amount));
    toast(`${inr(amount)} recorded. ${remaining > 0 ? `Remaining: ${inr(remaining)}` : 'Fully paid.'}`, 'success');
    m.close();
    await reload();
    after?.();
  });
}

/* ------------------------------------------------------------------ */
/* Edit record                                                         */
/* ------------------------------------------------------------------ */
function openEditRecord(kind, r) {
  const K = KINDS[kind];
  const formId = 'edit-form-' + Date.now();
  const form = h(`<form novalidate id="${formId}">
    <div class="form-grid">
      <div class="field span-2"><label>${K.party}</label><input class="input" value="${esc(r.party_name)}" disabled></div>
      <div class="field span-2"><label class="req" for="e-desc">Description / reference</label><input class="input" id="e-desc" name="desc" maxlength="300" value="${esc(r.description)}"></div>
      ${amountField('etotal', K.total, { required: true, value: Number(r.total_amount).toFixed(2).replace(/\.00$/, '') })}
      <div class="field"><label class="req" for="e-txn">Transaction date</label><input class="input" type="date" id="e-txn" name="txn" value="${esc(r.transaction_date)}"></div>
      <div class="field"><label for="e-due">Due date</label><input class="input" type="date" id="e-due" name="due" value="${esc(r.due_date || '')}"></div>
      <div class="field span-2"><label for="e-notes">Notes</label><textarea class="input" id="e-notes" name="notes" maxlength="2000" rows="3">${esc(r.notes || '')}</textarea></div>
    </div>
    ${Number(r.amount_paid) > 0 ? `<p class="hint">${K.paid} so far: ${inr(r.amount_paid)}. The total cannot be set below this.</p>` : ''}
    <div class="alert alert-error" data-error hidden style="margin-top:14px"></div>
  </form>`);
  const m = openModal({
    title: `Edit ${K.noun}`,
    body: form,
    footer: `<button type="button" class="btn" data-close>Cancel</button>
             <button type="submit" form="${formId}" class="btn btn-primary" data-save>Save changes</button>`,
  });
  const err = form.querySelector('[data-error]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.focus(); };
    const description = form.desc.value.replace(/\s+/g, ' ').trim();
    const total = parseAmount(form.etotal.value);
    if (!description) return fail('Enter a description or reference.', form.desc);
    if (!total || Number.isNaN(total) || total <= 0) return fail('Enter a valid total amount greater than zero.', form.etotal);
    if (toPaise(total) < toPaise(r.amount_paid)) return fail(`The total cannot be less than the amount already ${K.paid.toLowerCase()} (${inr(r.amount_paid)}).`, form.etotal);
    if (!form.txn.value) return fail('Enter the transaction date.', form.txn);
    if (form.due.value && form.due.value < form.txn.value) return fail('Due date cannot be before the transaction date.', form.due);

    const btn = m.footer.querySelector('[data-save]');
    setLoading(btn, true);
    const { error } = await sb.from(K.table).update({
      description, total_amount: total, transaction_date: form.txn.value,
      due_date: form.due.value || null, notes: form.notes.value.trim() || null,
    }).eq('id', r.id);
    setLoading(btn, false);
    if (error) return fail(errorMessage(error));
    toast('Changes saved', 'success');
    m.close();
    await reload();
    openRecord(kind, r.id);
  });
}

/* ------------------------------------------------------------------ */
/* Top buttons + boot                                                  */
/* ------------------------------------------------------------------ */
$('[data-action="add-vendor"]').addEventListener('click', async () => {
  const v = await openVendorForm();
  if (v) { toast(`${v.name} is now available in payables and the Vendor Directory`, 'success'); reload(); }
});
$('[data-action="add-client"]').addEventListener('click', addClient);

state.tab = parseHash().tab;
renderPanel(true);
try {
  await loadAll();
} catch (e) {
  panel.innerHTML = `<div class="alert alert-error">Could not load data: ${esc(errorMessage(e))}</div>`;
  throw e;
}
delete panel.dataset.rendered;
route();
