import { sb, safeNext } from '../supabase.js';
import { setLoading, errorMessage } from '../ui.js';

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const btn = document.getElementById('login-btn');

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = !text;
}

// Already signed in as admin → straight to the app.
const { data } = await sb.auth.getSession();
if (data.session) {
  const { data: role } = await sb.rpc('my_role');
  if (role) {
    location.replace(next);
  } else {
    await sb.auth.signOut();
  }
}
document.documentElement.classList.remove('auth-pending');
if (params.get('denied')) showError('This account has not been given access to this app.');

document.getElementById('pw-toggle').addEventListener('click', (e) => {
  const pw = form.password;
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
  e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const email = form.email.value.trim();
  const password = form.password.value;
  if (!email || !password) return showError('Enter your email and password.');

  setLoading(btn, true);
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showError(/invalid/i.test(error.message) ? 'Incorrect email or password.' : errorMessage(error));
      return;
    }
    const { data: role, error: roleErr } = await sb.rpc('my_role');
    if (roleErr) throw roleErr;
    if (!role) {
      await sb.auth.signOut();
      showError('This account has not been given access to this app.');
      return;
    }
    location.replace(next);
  } catch (err) {
    showError(errorMessage(err));
  } finally {
    setLoading(btn, false);
  }
});
