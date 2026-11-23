'use strict';
// Hotkey overlay: full-screen dimmed wheel. Esc or a click outside the ring dismisses it.
(function () {
  const api = window.sonika;
  let wheel = null;
  let lastTool = {};
  let picking = false;

  function close() {
    document.body.classList.remove('open');
    api.overlayDismiss();
  }

  async function init() {
    const st = await api.getState();
    lastTool = (st.settings && st.settings.lastTool) || {};
    wheel = new window.Wheel(document.getElementById('ov-wheel'), {
      categories: st.categories,
      tools: st.tools,
      lastTool,
      maxScale: 1.17,
      pointerArea: document.getElementById('ov-stage'),
      onOutsideClick: () => close(),
      onPick: async (tool) => {
        if (picking) return;
        picking = true;
        document.body.classList.remove('open');
        try { await api.overlayPick(tool.id); } finally { picking = false; }
      },
    });
    api.on('registry', (r) => wheel.setData(r.categories, r.tools, lastTool));
    api.on('settings', (s) => { lastTool = s.lastTool || {}; });
    api.on('overlay-open', (p) => {
      // Re-arm: put the selection on the slot the pointer is already pointing at, if any.
      if (p && p.lastTool) lastTool = p.lastTool;
      wheel.setLit(null);
      wheel.setData(wheel.categories, wheel.tools, lastTool);
      document.body.classList.add('open');
      wheel.host.focus();
      if (p && p.cursor) {
        const i = wheel.segmentAt(p.cursor.x, p.cursor.y, true);
        if (i >= 0) wheel.select(i);
      }
      requestAnimationFrame(() => requestAnimationFrame(() => api.overlayShown(p && p.token)));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (document.activeElement !== wheel.host) { wheel.host.focus(); wheel.onKey(e); }
    });
    window.addEventListener('blur', () => document.body.classList.remove('open'));
    window.SonikaOverlay = { get wheel() { return wheel; }, close };
    document.body.dataset.ready = '1';
  }

  init();
})();
