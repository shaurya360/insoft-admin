import { initShell } from '../layout.js';
import { sb } from '../supabase.js';
import { ICONS, inr, esc, fmtDate, todayISO, loadingBlock, emptyState, errorMessage, toast } from '../ui.js';

await initShell('dashboard');

document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon]; });
const hour = new Date().getHours();
document.getElementById('greeting').textContent =
  `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}. Here is where things stand.`;

const duePay = document.getElementById('due-payables');
const dueRec = document.getElementById('due-receivables');
duePay.innerHTML = dueRec.innerHTML = loadingBlock();

function dueList(rows, kind) {
  if (!rows.length) {
    return emptyState({ icon: 'inbox', title: 'Nothing outstanding', text: kind === 'payables' ? 'No unpaid vendor balances.' : 'No unpaid client balances.' });
  }
  const today = todayISO();
  return `<div class="table-wrap"><table class="table"><tbody>
    ${rows.map((r) => `
      <tr class="clickable" data-href="money.html#${kind}/${r.id}">
        <td><div class="cell-title">${esc(r.party_name)}</div><div class="cell-sub">${esc(r.description)}</div></td>
        <td class="nowrap small">${r.due_date
          ? `<span class="${r.due_date < today ? 'overdue' : 'muted'}">${r.due_date < today ? 'Overdue · ' : 'Due '}${fmtDate(r.due_date)}</span>`
          : '<span class="muted">No due date</span>'}</td>
        <td class="num cell-title">${inr(r.balance)}</td>
      </tr>`).join('')}
  </tbody></table></div>`;
}

document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-href]');
  if (tr) location.href = tr.dataset.href;
});

try {
  const [stats, pay, rec] = await Promise.all([
    sb.rpc('dashboard_stats'),
    sb.from('payables_view').select('id, party_name, description, due_date, balance').gt('balance', 0)
      .order('due_date', { ascending: true, nullsFirst: false }).limit(6),
    sb.from('receivables_view').select('id, party_name, description, due_date, balance').gt('balance', 0)
      .order('due_date', { ascending: true, nullsFirst: false }).limit(6),
  ]);
  for (const r of [stats, pay, rec]) if (r.error) throw r.error;
  const s = stats.data;
  document.querySelector('[data-stat="vendors"]').textContent = Number(s.vendors).toLocaleString('en-IN');
  document.querySelector('[data-stat="clients"]').textContent = Number(s.clients).toLocaleString('en-IN');
  document.querySelector('[data-stat="payable_outstanding"]').textContent = inr(s.payable_outstanding);
  document.querySelector('[data-stat="receivable_outstanding"]').textContent = inr(s.receivable_outstanding);
  duePay.innerHTML = dueList(pay.data, 'payables');
  dueRec.innerHTML = dueList(rec.data, 'receivables');
} catch (e) {
  toast(errorMessage(e), 'error');
  duePay.innerHTML = dueRec.innerHTML = `<div class="card-pad"><div class="alert alert-error">${esc(errorMessage(e))}</div></div>`;
}
