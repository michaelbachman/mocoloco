console.log("[BOOT] boot.js loaded");
try {
  const r = document.getElementById('root');
  if (r && !r.dataset.booted) {
    r.dataset.booted = '1';
    const div = document.createElement('div');
    div.textContent = 'Loading… (boot)';
    div.style.cssText = 'padding:12px;font:14px system-ui;color:#111;background:#fff;border:1px solid #eee;border-radius:8px;display:inline-block';
    r.appendChild(div);
  }
} catch(e){ console.warn("[BOOT] error", e); }
