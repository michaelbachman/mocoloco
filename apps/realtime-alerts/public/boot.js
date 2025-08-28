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


(async function loadFromManifest(){
  try {
    console.log("[BOOT] fetching manifest.json");
    const res = await fetch('/manifest.json', { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) throw new Error("manifest fetch failed: " + res.status);
    const manifest = await res.json();

    // Heuristics: find the first entry with isEntry === true and file ending with .js
    const entries = Object.values(manifest).filter(x => x && x.isEntry && typeof x.file === 'string' && x.file.endsWith('.js'));
    let entry = entries[0]?.file;
    if (!entry) {
      // Fallback: try common keys
      const guessKeys = ['src/main.jsx', 'src/main.tsx', 'index.html'];
      for (const k of guessKeys) {
        if (manifest[k]?.file?.endsWith('.js')) { entry = manifest[k].file; break; }
      }
    }
    if (!entry) throw new Error("no entry in manifest");

    console.log("[BOOT] loading app module:", entry);
    const s = document.createElement('script');
    s.type = 'module';
    s.src = '/' + entry.replace(/^\//, '');
    s.onload = () => console.log("[BOOT] app module loaded via manifest");
    s.onerror = (e) => {
      console.error("[BOOT] app module failed to load", e);
      const r = document.getElementById('root');
      if (r) r.append(" — bundle failed to load (manifest)");
    };
    document.head.appendChild(s);
  } catch (e) {
    console.error("[BOOT] manifest loader error", e);
    const r = document.getElementById('root');
    if (r) r.append(" — failed to bootstrap (manifest)");
  }
})();
