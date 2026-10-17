// App shell: sidebar navigation (desktop) / drawer + top bar (mobile).
import { requireUser, currentUser, currentRole, isAdmin, logout } from './supabase.js';
import { ICONS, esc, $ } from './ui.js';

const NAV = [
  { href: 'dashboard.html', key: 'dashboard', label: 'Dashboard', icon: 'home' },
  { href: 'quotation.html', key: 'quotation', label: 'Quotation Generator', icon: 'file' },
  { href: 'money.html', key: 'money', label: 'Money Manager', icon: 'wallet', adminOnly: true, children: [
    { href: 'money.html#payables', key: 'payables', label: 'Vendor Payables' },
    { href: 'money.html#receivables', key: 'receivables', label: 'Client Receivables' },
    { href: 'money.html#clients', key: 'clients', label: 'Clients' },
  ] },
  { href: 'vendors.html', key: 'vendors', label: 'Vendor Directory', icon: 'store' },
  { href: 'enquiries.html', key: 'enquiries', label: 'Website Enquiries', icon: 'inbox' },
];

/**
 * Builds the shell around the page's <main id="page"> content.
 * Resolves after authentication succeeds. { adminOnly } pages send employees to the dashboard.
 */
export async function initShell(activeKey, { adminOnly = false } = {}) {
  await requireUser({ adminOnly });
  const page = $('#page');
  const user = currentUser();

  const navHtml = NAV.filter((item) => !item.adminOnly || isAdmin()).map((item) => `
    <a href="${item.href}" class="${item.key === activeKey ? 'active' : ''}" data-key="${item.key}">${ICONS[item.icon]}<span>${item.label}</span></a>
    ${item.key === activeKey && item.children ? item.children.map((c) => `<a href="${c.href}" class="sub" data-sub="${c.key}">${c.label}</a>`).join('') : ''}
  `).join('');

  const shell = document.createElement('div');
  shell.className = 'shell';
  shell.innerHTML = `
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <div class="brand">
        <img src="logo.jpg" alt="" onerror="this.style.display='none'">
        <div><div class="brand-name">INSOFT TECHNOLOGY</div><div class="brand-sub">Admin</div></div>
      </div>
      <nav class="nav">${navHtml}</nav>
      <div class="sidebar-foot">
        <div class="user-email" title="${esc(user?.email)}">${esc(user?.email)}<span class="role-badge">${currentRole() === 'admin' ? 'Admin' : 'Employee'}</span></div>
        <button type="button" class="btn btn-block" data-logout>${ICONS.logout} Log out</button>
      </div>
    </aside>
    <div class="backdrop" data-nav-close></div>
    <div class="main">
      <header class="topbar">
        <button type="button" class="icon-btn" data-nav-open aria-label="Open menu">${ICONS.menu}</button>
        <a class="brand" href="dashboard.html" style="text-decoration:none;color:inherit">
          <img src="logo.jpg" alt="" onerror="this.style.display='none'"><div class="brand-name">INSOFT Admin</div>
        </a>
        <div class="topbar-actions">
          <a class="icon-btn" href="dashboard.html" aria-label="Dashboard" title="Dashboard">${ICONS.home}</a>
          <button type="button" class="icon-btn" data-logout aria-label="Log out" title="Log out">${ICONS.logout}</button>
        </div>
      </header>
    </div>`;
  page.parentNode.insertBefore(shell, page);
  page.classList.add('content');
  shell.querySelector('.main').appendChild(page);

  shell.addEventListener('click', (e) => {
    if (e.target.closest('[data-logout]')) logout();
    else if (e.target.closest('[data-nav-open]')) document.body.classList.add('nav-open');
    else if (e.target.closest('[data-nav-close]') || e.target.closest('.nav a')) document.body.classList.remove('nav-open');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('nav-open'); });
}

/** Highlight the active sub-link (Money Manager tabs). */
export function setActiveSub(key) {
  document.querySelectorAll('.nav a.sub').forEach((a) => a.classList.toggle('active', a.dataset.sub === key));
}
