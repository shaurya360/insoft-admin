// Registers the service worker so the app can be installed on phones ("Add to Home screen").
// Service workers need HTTPS (or localhost for testing).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app works without it */ });
  });
}
