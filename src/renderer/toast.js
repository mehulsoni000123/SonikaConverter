'use strict';
// Small always-on-top progress card for jobs started from the hotkey wheel or from Explorer.
(function () {
  const api = window.sonika;
  const Icons = window.Icons;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (p) => String(p).split(/[\\/]/).pop();
  let jobs = [];
  let hideTimer = null;
  let hovering = false;

  const list = document.getElementById('toast-list');
  const card = document.getElementById('card');
  document.getElementById('toast-close').innerHTML = Icons.svg('close', 15);
  document.getElementById('toast-close').addEventListener('click', () => api.toastHide());
  card.addEventListener('mouseenter', () => { hovering = true; clearTimeout(hideTimer); });
  card.addEventListener('mouseleave', () => { hovering = false; scheduleHide(); });

  function pct(j) {
    if (j.status === 'done') return 'Done';
    if (j.status === 'error') return 'Failed';
    if (j.status === 'cancelled') return 'Cancelled';
    if (j.status === 'queued') return 'Waiting';
    return j.progress > 0 ? `${Math.round(j.progress * 100)}%` : 'Working';
  }

  function render() {
    const shown = jobs.slice(-4).reverse();
    const active = jobs.filter((j) => ['queued', 'running', 'cancelling'].includes(j.status)).length;
    document.getElementById('toast-title').textContent = active ? `Converting ${active} file${active > 1 ? 's' : ''}` : 'All done';
    list.innerHTML = shown.map((j) => {
      const running = ['queued', 'running', 'cancelling'].includes(j.status);
      const sub = j.status === 'error' ? j.error : j.status === 'done'
        ? (j.outputs && j.outputs.length === 1 ? `Saved ${base(j.outputs[0])}` : (j.message || 'Done'))
        : `${j.toolLabel}${j.statusText ? ' - ' + j.statusText : ''}`;
      return `<div class="toast-job ${j.status}" data-id="${esc(j.id)}">
        <div class="row"><span class="name" title="${esc(j.title)}">${esc(j.title)}</span><span class="pct">${esc(pct(j))}</span>
          ${j.status === 'done' && j.outputs && j.outputs.length ? `<button class="btn btn-sm" data-show="${esc(j.id)}">${Icons.svg('folder', 13)}Show</button>` : ''}</div>
        <div class="sub">${esc(sub)}</div>
        ${running ? `<div class="job-bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>` : ''}
      </div>`;
    }).join('') + (jobs.length > 4 ? `<div class="toast-job"><div class="sub">and ${jobs.length - 4} more in the main window</div></div>` : '');
    requestAnimationFrame(() => api.toastResize(card.offsetHeight + 2));
    scheduleHide();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    const active = jobs.some((j) => ['queued', 'running', 'cancelling'].includes(j.status));
    if (!active && jobs.length && !hovering) hideTimer = setTimeout(() => api.toastHide(), 6000);
  }

  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) api.showOutput(b.dataset.show);
  });

  api.on('toast-jobs', (j) => { jobs = j || []; render(); });
  document.body.dataset.ready = '1';
})();
