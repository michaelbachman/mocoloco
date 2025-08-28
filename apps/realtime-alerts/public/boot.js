// boot.js — optional helper if your index.html doesn't manually call init
(function(){
  function ready(fn){ if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function(){
    if (window.initApp) {
      try { window.initApp(); } catch(e){ console.error('[BOOT] initApp error', e); }
    }
  });
})();
