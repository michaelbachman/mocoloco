(function(){
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs||{})) {
      if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'className') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const c of (children||[])) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };

  const root = document.getElementById('root');
  if (root) root.textContent = 'Loading… (boot)';

  // Diagnostics overlay
  const overlay = el('div', { id: 'boot-diag', style: {
    position: 'fixed', inset: '12px', border: '1px solid #e5e7eb55',
    borderRadius: '12px', background: 'Canvas', color: 'CanvasText',
    boxShadow: '0 6px 30px rgba(0,0,0,.18)', zIndex: 2147483647,
    display: 'none', padding: '12px', maxWidth: '960px', margin: '0 auto'
  }});
  const head = el('div', { style: { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'8px' }}, [
    el('div', { style:{ fontWeight:600 }}, ['Boot diagnostics']),
    el('div', {}, [
      el('button', { id:'btn-hide', style:{ padding:'6px 10px', borderRadius:'10px', border:'1px solid #ccc', marginRight:'8px' }}, ['Hide']),
      el('button', { id:'btn-retry', style:{ padding:'6px 10px', borderRadius:'10px', border:'1px solid #ccc' }}, ['Retry'])
    ])
  ]);
  const body = el('div', {});
  const stat = el('div', { style:{ fontSize:'12px', opacity:.8, marginTop:'6px' }}, ['Status: —']);
  const logBox = el('div', { id:'boot-log', style: { marginTop:'10px', fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize:'12px', maxHeight:'200px', overflow:'auto', border:'1px solid #eee', borderRadius:'8px', padding:'8px' } });
  overlay.append(head, body, stat, logBox);
  document.body.appendChild(overlay);

  const show = () => overlay.style.display = 'block';
  const hide = () => overlay.style.display = 'none';
  document.getElementById('btn-hide').onclick = hide;
  document.getElementById('btn-retry').onclick = () => location.reload();

  const setStatus = (s) => stat.textContent = 'Status: ' + s;
  const log = (m) => {
    const line = el('div', {}, [new Date().toLocaleTimeString(), ' — ', m]);
    logBox.append(line);
    logBox.scrollTop = logBox.scrollHeight;
    console.log('[BOOT]', m);
  };

  async function clearSWCaches() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      log('Cleared SW registrations and caches');
    } catch (e) {
      log('SW/cache clear error: ' + (e && e.message));
    }
  }

  async function loadFromManifest() {
    log('fetching /manifest.json');
    const res = await fetch('/manifest.json', { credentials: 'same-origin', cache:'no-store' });
    if (!res.ok) throw new Error('manifest fetch failed: ' + res.status);
    const manifest = await res.json();
    const entry = Object.values(manifest).find(x => x && x.isEntry && x.file);
    if (!entry) throw new Error('entry not found in manifest');
    const src = '/' + String(entry.file).replace(/^\//, '');
    log('loading app module via manifest: ' + src);
    await import(src);
    log('app module loaded via manifest');
  }

  async function main() {
    try {
      setStatus('booting');
      await loadFromManifest();
      setStatus('app loaded');
      // Hide overlay on success in case it was shown
      hide();
    } catch (e) {
      setStatus('error');
      show();
      body.innerHTML = '';
      body.append(
        el('div', { style:{ marginBottom:'6px' }}, ['Could not load the app bundle.']),
        el('div', { style:{ fontSize:'12px', opacity:.85 }}, [
          'This can happen right after a deploy or if a cached index.html points to an old asset hash.'
        ]),
        el('div', { style:{ marginTop:'10px', display:'flex', gap:'8px', flexWrap:'wrap' }}, [
          el('button', { id:'btn-hardreload', style:{ padding:'6px 10px', borderRadius:'10px', border:'1px solid #ccc' }}, ['Hard reload']),
          el('button', { id:'btn-clearcaches', style:{ padding:'6px 10px', borderRadius:'10px', border:'1px solid #ccc' }}, ['Unregister SW & clear caches'])
        ])
      );
      document.getElementById('btn-hardreload')?.addEventListener('click', () => {
        const u = new URL(location.href);
        u.searchParams.set('v', Date.now().toString());
        location.replace(u.toString());
      });
      document.getElementById('btn-clearcaches')?.addEventListener('click', async () => {
        await clearSWCaches();
        setTimeout(() => location.reload(), 300);
      });
      log('manifest loader error: ' + (e && e.message));
    }
  }

  main();
})();
