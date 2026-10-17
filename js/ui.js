// Small UI toolkit: formatting, money maths, toasts, dialogs, comboboxes, tag inputs.

/* ---------------- Formatting ---------------- */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
/** ₹1,23,456.50 — accepts numbers or numeric strings from Postgres. */
export function inr(value) {
  return inrFmt.format(Number(value || 0));
}

/** Money as integer paise to avoid floating-point drift in sums. */
export const toPaise = (v) => Math.round(Number(v || 0) * 100);
export const fromPaise = (p) => p / 100;
export const sumMoney = (rows, key) => fromPaise(rows.reduce((s, r) => s + toPaise(r[key]), 0));

/** Parse a user-entered amount. Returns null if empty, NaN if invalid. */
export function parseAmount(str) {
  const s = String(str ?? '').replace(/[₹,\s]/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Number(s);
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → '17 Oct 2026' (parsed as a local date, no timezone shift). */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? 'tel:' + digits : '';
}

/** WhatsApp chat link. 10-digit numbers are treated as Indian (+91). */
export function waHref(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d.length >= 8 ? `https://wa.me/${d}` : '';
}

/** Call / WhatsApp / copy buttons for a phone number. */
export function phoneActions(phone, { label = '' } = {}) {
  if (!phone) return '';
  const wa = waHref(phone);
  return `<span class="phone-actions">
    <a class="icon-btn" href="${esc(telHref(phone))}" title="Call ${esc(label)}" aria-label="Call ${esc(label)}" data-stop>${ICONS.phone}</a>
    ${wa ? `<a class="icon-btn wa" href="${esc(wa)}" target="_blank" rel="noopener" title="WhatsApp ${esc(label)}" aria-label="WhatsApp ${esc(label)}" data-stop>${ICONS.whatsapp}</a>` : ''}
    <button type="button" class="icon-btn" data-copy="${esc(phone)}" title="Copy number" aria-label="Copy number">${ICONS.copy}</button>
  </span>`;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function statusBadge(status) {
  const cls = status === 'Paid' ? 'badge-paid' : status === 'Partially Paid' ? 'badge-partial' : 'badge-unpaid';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

/** Friendly message for Supabase / Postgres errors. */
export function errorMessage(error) {
  if (!error) return 'Something went wrong.';
  const msg = error.message || String(error);
  const details = `${msg} ${error.details || ''}`;
  if (error.code === '23505') {
    if (/phone_key/.test(details)) return 'A record with this phone number already exists.';
    if (/name_nophone/.test(details)) return 'A record with this name (and no phone number) already exists. Add a phone number or use a different name.';
    if (/quotations_ref_uq/.test(details)) return 'This reference number is already used by another saved document.';
    return 'This record already exists.';
  }
  if (error.code === '23503') return 'This record is linked to other records (for example payments or transactions) and cannot be removed.';
  if (/violates check constraint/.test(msg)) {
    if (/(payables|receivables)_check"/.test(msg)) return 'Due date cannot be before the transaction date.';
    if (/amount_check/.test(msg)) return 'Amounts must be greater than zero.';
    return 'Some of the entered values are not valid.';
  }
  if (error.code === '23514' || error.code === 'P0001') return msg.replace(/\(remaining: ([\d.]+)\)/, (_, n) => `(remaining: ${inr(n)})`).replace(/\(([\d.]+)\)$/, (_, n) => `(${inr(n)})`);
  if (error.code === '42501') return 'You are not authorized to do this.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Network error — check your internet connection and try again.';
  return msg;
}

/* ---------------- DOM helpers ---------------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

export function loadingBlock(text = 'Loading…') {
  return `<div class="loading-block"><span class="spinner"></span>${esc(text)}</div>`;
}

export function emptyState({ icon = 'inbox', title, text = '', action = '' }) {
  return `<div class="empty">${ICONS[icon] || ''}<h3>${esc(title)}</h3><div>${esc(text)}</div>${action}</div>`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ' + text, 'success');
  } catch {
    toast('Could not copy to clipboard', 'error');
  }
}

/* ---------------- Toasts ---------------- */
let toastRoot;
export function toast(message, type = 'info', ms = 3500) {
  if (!toastRoot) {
    toastRoot = h('<div class="toasts" role="status" aria-live="polite"></div>');
    document.body.appendChild(toastRoot);
  }
  const el = h(`<div class="toast ${type}"></div>`);
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? ms + 2500 : ms);
}

/* ---------------- Dialogs ---------------- */
/**
 * openModal({ title, subtitle, body: string|Node, footer: string|Node, wide })
 * Returns { dialog, body, footer, close(), onClose(fn) }.
 */
export function openModal({ title, subtitle = '', body = '', footer = '', wide = false }) {
  const dlg = h(`
    <dialog class="modal${wide ? ' wide' : ''}">
      <div class="modal-inner">
        <div class="modal-head">
          <div><h2></h2>${subtitle ? '<p></p>' : ''}</div>
          <button type="button" class="icon-btn" data-close aria-label="Close">${ICONS.x}</button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>
    </dialog>`);
  dlg.querySelector('h2').textContent = title;
  if (subtitle) dlg.querySelector('.modal-head p').textContent = subtitle;
  const bodyEl = dlg.querySelector('.modal-body');
  const footEl = dlg.querySelector('.modal-foot');
  typeof body === 'string' ? (bodyEl.innerHTML = body) : bodyEl.appendChild(body);
  typeof footer === 'string' ? (footEl.innerHTML = footer) : footEl.appendChild(footer);
  if (!footer) footEl.remove();

  const closers = [];
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.addEventListener('close', () => { closers.forEach((fn) => fn()); dlg.remove(); });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  const first = bodyEl.querySelector('input:not([type=hidden]):not([disabled]), textarea, select');
  if (first) first.focus();
  return { dialog: dlg, body: bodyEl, footer: footEl, close, onClose: (fn) => closers.push(fn) };
}

/** Promise<boolean> confirmation dialog (native confirm() is not used). */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title,
      body: `<p style="margin:0">${esc(message)}</p>`,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
    });
    m.footer.querySelector('[data-ok]').addEventListener('click', () => { result = true; m.close(); });
    m.footer.querySelector('[data-ok]').focus();
    m.onClose(() => resolve(result));
  });
}

/* ---------------- Combobox ---------------- */
/**
 * Searchable single-select built on a text input.
 * createCombobox(input, {
 *   getOptions: () => [{ value, label, sub?, group?, search? }],
 *   onChange: (option|null) => void,
 *   allowCreate: false | (text) => label,   // offer "Add “text”"
 *   onCreate: (text) => void,
 *   placeholder,
 *   keepText: true    // keep typed text that matches no option
 *   freeText: true    // input is a normal text field with suggestions; editing keeps the selection
 *   plain: true       // don't apply the .input class (keep the host page's input styling)
 * })
 * Returns { setValue(value), value(), clear(), refresh() }.
 */
export function createCombobox(input, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  if (!opts.plain) input.classList.add('input');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  if (opts.placeholder) input.placeholder = opts.placeholder;
  const clearBtn = h('<button type="button" class="combo-clear" aria-label="Clear" hidden>×</button>');
  const list = h('<ul class="combo-list" role="listbox" hidden></ul>');
  wrap.append(clearBtn, list);

  let selected = null;
  let items = [];
  let active = -1;

  const norm = (s) => String(s || '').toLowerCase().trim();

  function render() {
    const q = norm(input.value === selected?.label ? '' : input.value);
    const all = opts.getOptions();
    let matches = q ? all.filter((o) => norm(o.search || `${o.label} ${o.sub || ''}`).includes(q)) : all;
    matches = matches.slice(0, 200);
    items = [];
    list.innerHTML = '';
    let lastGroup = null;
    for (const o of matches) {
      if (o.group && o.group !== lastGroup) {
        lastGroup = o.group;
        list.appendChild(h(`<li class="group">${esc(o.group)}</li>`));
      }
      const li = h(`<li role="option"><span>${esc(o.label)}</span>${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</li>`);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(o); });
      items.push({ li, o });
      list.appendChild(li);
    }
    const text = input.value.trim();
    if (opts.allowCreate && text && !all.some((o) => norm(o.label) === norm(text))) {
      const li = h(`<li class="create" role="option">${esc(opts.allowCreate(text))}</li>`);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); create(text); });
      items.push({ li, create: text });
      list.appendChild(li);
    }
    if (!items.length) list.appendChild(h(`<li class="empty">${opts.isLoading?.() ? 'Loading…' : q ? 'No matches' : 'Nothing to show yet'}</li>`));
    active = items.length ? 0 : -1;
    highlight();
  }

  function highlight() {
    items.forEach((it, i) => it.li.classList.toggle('active', i === active));
    items[active]?.li.scrollIntoView({ block: 'nearest' });
  }

  function open() { render(); list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
  function closeList() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }

  function choose(o, silent = false) {
    selected = o;
    if (o || !opts.freeText) input.value = o ? o.label : '';
    clearBtn.hidden = !o || !!opts.freeText;
    closeList();
    if (!silent) opts.onChange?.(o);
  }

  function create(text) {
    closeList();
    opts.onCreate?.(text);
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', () => {
    if (!opts.freeText && selected && input.value !== selected.label) { selected = null; clearBtn.hidden = true; opts.onChange?.(null); }
    open();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else { active = Math.min(active + 1, items.length - 1); highlight(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter') {
      if (!list.hidden && items[active]) {
        e.preventDefault();
        const it = items[active];
        it.create ? create(it.create) : choose(it.o);
      }
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); e.stopPropagation(); closeList(); }
    } else if (e.key === 'Tab') closeList();
  });
  input.addEventListener('blur', () => {
    closeList();
    if (opts.freeText) return;
    if (!selected && !opts.keepText) input.value = '';
    else if (selected && input.value !== selected.label) input.value = selected.label;
  });
  clearBtn.addEventListener('click', () => { choose(null); input.focus(); });

  return {
    value: () => selected?.value ?? null,
    option: () => selected,
    setValue(value, silent = true) {
      const o = opts.getOptions().find((x) => x.value === value) || null;
      choose(o, silent);
    },
    clear: (silent = true) => choose(null, silent),
    refresh: () => { if (!list.hidden) render(); },
  };
}

/* ---------------- Tag input ---------------- */
/**
 * createTagInput(container, { values, suggestions: () => [string], placeholder })
 * Returns { values() }.
 */
export function createTagInput(container, { values = [], suggestions = () => [], placeholder = 'Type and press Enter' } = {}) {
  container.classList.add('tags');
  const input = h(`<input type="text" autocomplete="off">`);
  input.placeholder = placeholder;
  const list = h('<ul class="combo-list" hidden></ul>');
  container.append(input, list);
  let tags = [];
  let active = -1;
  let items = [];

  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

  function add(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 80 || tags.some((x) => norm(x) === norm(t))) return;
    tags.push(t);
    const chip = h(`<span class="tag"><span></span><button type="button" aria-label="Remove">×</button></span>`);
    chip.firstChild.textContent = t;
    chip.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      tags = tags.filter((x) => x !== t);
      chip.remove();
    });
    container.insertBefore(chip, input);
  }

  function render() {
    const q = norm(input.value);
    const pool = suggestions().filter((s) => !tags.some((t) => norm(t) === norm(s)));
    const matches = (q ? pool.filter((s) => norm(s).includes(q)) : pool).slice(0, 50);
    list.innerHTML = '';
    items = matches.map((s) => {
      const li = h(`<li>${esc(s)}</li>`);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); add(s); input.value = ''; render(); });
      list.appendChild(li);
      return { li, s };
    });
    active = -1;
    list.hidden = !items.length;
  }

  const hl = () => items.forEach((it, i) => it.li.classList.toggle('active', i === active));

  container.addEventListener('click', () => input.focus());
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => {
    list.hidden = true;
    if (input.value.trim()) { add(input.value); input.value = ''; }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); list.hidden = false; active = Math.min(active + 1, items.length - 1); hl(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = Math.max(active - 1, 0); hl(); }
    else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (active >= 0 && items[active]) add(items[active].s);
      else if (input.value.trim()) add(input.value);
      input.value = '';
      render();
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      container.querySelectorAll('.tag')[tags.length]?.remove();
    } else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); e.preventDefault(); list.hidden = true; }
  });

  values.forEach(add);
  return { values: () => [...tags], input };
}

/* ---------------- Icons (inline SVG, stroke = currentColor) ---------------- */
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>'),
  file: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>'),
  wallet: svg('<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2"/>'),
  store: svg('<path d="M3 9 4.5 4h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 13v7h14v-7"/><path d="M10 20v-4h4v4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>'),
  logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  pin: svg('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  rupee: svg('<path d="M6 4h12M6 9h12M10 4a5 5 0 0 1 0 10H6l8 6"/>'),
  inbox: svg('<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>'),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.5 14.98L2 22l5.16-1.5A9.9 9.9 0 1 0 12.04 2Zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.06.9.92-2.98-.2-.31a8.2 8.2 0 1 1 6.82 3.72Zm4.5-6.14c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.78.97-.14.16-.29.18-.53.06a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.41-.56-.42h-.47a.9.9 0 0 0-.66.31 2.77 2.77 0 0 0-.86 2.06 4.8 4.8 0 0 0 1 2.55 11 11 0 0 0 4.2 3.71c1.56.68 2.18.73 2.96.62.48-.07 1.46-.6 1.67-1.18.2-.58.2-1.08.14-1.18-.06-.1-.22-.16-.47-.28Z"/></svg>',
  filter: svg('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'),
};
