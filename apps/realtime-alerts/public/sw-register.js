(async function(){
  // No-op SW registration placeholder for now
  try {
    if ('serviceWorker' in navigator) {
      // In case you later add a SW file, you can register here.
      // navigator.serviceWorker.register('/sw.js');
      console.log('[SW] no service worker registered');
    }
  } catch(e){ console.warn('[SW] registration skipped', e); }
})();
