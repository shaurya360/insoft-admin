// Supabase client + authentication guard shared by every page.
// Requires (classic scripts, loaded before this module):
//   https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js
//   js/config.js  (generated from .env — see README)

const cfg = window.APP_CONFIG || {};

function fatal(message) {
  document.documentElement.classList.remove('auth-pending');
  document.body.innerHTML = `
    <div class="card fatal">
      <h2 style="font-size:18px;margin-bottom:8px">Application not configured</h2>
      <p class="muted" style="margin:0">${message}</p>
    </div>`;
  throw new Error(message);
}

if (!window.supabase?.createClient) fatal('Could not load the Supabase library. Check your internet connection and reload.');
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || /YOUR_/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY)) {
  fatal('Missing Supabase settings. Create <code>.env</code> from <code>.env.example</code> and run <code>npm run config</code>.');
}

export const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'insoft-admin-auth' },
});

const PAGES = /^(dashboard|quotation|money|vendors)\.html(\?[^#]*)?(#.*)?$/;

/** Only allow redirects to our own pages (no open redirects). */
export function safeNext(next) {
  return next && PAGES.test(next) ? next : 'dashboard.html';
}

function currentPage() {
  const file = location.pathname.split('/').pop() || 'dashboard.html';
  return file + location.search + location.hash;
}

let session = null;

/**
 * Ensures a signed-in administrator. Redirects to the login page otherwise.
 * Resolves with the session; reveals the page.
 */
export async function requireAdmin() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (!session) {
    location.replace('login.html?next=' + encodeURIComponent(currentPage()));
    return new Promise(() => {});
  }
  const { data: isAdmin, error } = await sb.rpc('is_admin');
  if (error) {
    // Expired / revoked refresh token → back to login. Anything else: show it.
    if (error.code === 'PGRST301' || /JWT|token/i.test(error.message)) {
      await sb.auth.signOut();
      location.replace('login.html?next=' + encodeURIComponent(currentPage()));
      return new Promise(() => {});
    }
    fatal('Could not verify your access: ' + error.message + '. Check your connection and reload.');
  }
  if (!isAdmin) {
    await sb.auth.signOut();
    location.replace('login.html?denied=1');
    return new Promise(() => {});
  }
  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_OUT' || !s) location.replace('login.html');
  });
  document.documentElement.classList.remove('auth-pending');
  return session;
}

export function currentUser() {
  return session?.user ?? null;
}

export async function logout() {
  try { await sb.auth.signOut(); } finally { location.replace('login.html'); }
}
