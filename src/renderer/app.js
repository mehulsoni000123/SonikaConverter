'use strict';
// Main window: wheel home screen, options sheet (Flow A), drag-and-drop files (Flow B), jobs list, settings.
(function () {
  const api = window.sonika;
  const Icons = window.Icons;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = (p) => String(p).split(/[\\/]/).pop();
  const dirOf = (p) => { const b = base(p); return String(p).slice(0, String(p).length - b.length).replace(/[\\/]$/, ''); };
  const extOf = (p) => { const b = base(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

  const S = {
    categories: [], tools: [], loadErrors: [], settings: {}, hotkey: {}, detect: {}, version: '',
    jobs: new Map(), view: 'wheel', tool: null, files: [], options: {}, held: [], settingsOpen: false,
  };
  let wheel = null;

  // ------------------------------------------------------------------ helpers
  const catOf = (id) => S.categories.find((c) => c.id === id) || { id, label: id.toUpperCase(), hint: '' };
  const toolById = (id) => S.tools.find((t) => t.id === id) || null;
  const toolsIn = (catId) => S.tools.filter((t) => t.category === catId);
  const accepts = (tool, p) => tool.accepts.includes(extOf(p));
  const typesText = (tool) => tool.accepts.map((e) => e.replace('.', '').toUpperCase()).join(', ');

  function savedOptions(tool) {
    const out = {};
    for (const o of tool.options || []) out[o.key] = o.default;
    const saved = (S.settings.toolOptions || {})[tool.id] || {};
    for (const o of tool.options || []) if (Object.prototype.hasOwnProperty.call(saved, o.key)) out[o.key] = saved[o.key];
    return out;
  }

  function preferredTool(catId, candidates) {
    const last = (S.settings.lastTool || {})[catId];
    return candidates.find((t) => t.id === last) || candidates.find((t) => t.isDefault) || candidates[0] || null;
  }

  let noticeTimer = null;
  function notice(kind, text, ms) {
    const n = $('#notice');
    const icon = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'bolt';
    n.className = 'notice ' + kind;
    n.innerHTML = Icons.svg(icon, 15) + `<span>${esc(text)}</span>`;
    n.title = text;
    void n.offsetWidth;
    n.classList.add('show');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => n.classList.remove('show'), ms || (kind === 'error' ? 6000 : 3500));
  }

  // ------------------------------------------------------------------ state
  function applyState(st) {
    S.categories = st.categories || [];
    S.tools = st.tools || [];
    S.loadErrors = st.loadErrors || [];
    S.settings = st.settings || {};
    S.hotkey = st.hotkey || {};
    S.detect = st.tools_detect || {};
    S.version = st.version || '';
    S.jobs = new Map((st.jobs || []).map((j) => [j.id, j]));
    updateWarnDot();
  }

  function updateWarnDot() {
    const bad = (S.hotkey && S.hotkey.accelerator && !S.hotkey.ok) || (S.detect.ffmpeg && !S.detect.ffmpeg.ok);
    $('#settings-warn').hidden = !bad;
  }

  // ------------------------------------------------------------------ wheel
  function buildWheel() {
    wheel = new window.Wheel($('#wheel-host'), {
      categories: S.categories,
      tools: S.tools,
      lastTool: S.settings.lastTool || {},
      pointerArea: $('#stage'),
      guard: (e) => S.view === 'wheel' && !S.settingsOpen && !(e.target && e.target.closest && e.target.closest('.held-bar, .stage-foot')),
      onPick: (tool, cat) => {
        if (S.held.length) handleFiles(S.held, { categoryId: cat.id, tool });
        else openOptions(tool, []);
      },
    });
  }

  // ------------------------------------------------------------------ Flow B: files first
  /** opts: { categoryId, tool, viaDrop } */
  function handleFiles(paths, opts) {
    opts = opts || {};
    paths = [...new Set((paths || []).filter(Boolean))];
    if (!paths.length) return { action: 'none' };
    if (S.view === 'options' && !opts.categoryId) { addFilesToSheet(paths); return { action: 'added' }; }
    const fitting = S.tools.filter((t) => paths.some((p) => accepts(t, p)));
    const what = paths.length === 1 ? 'this file type' : 'these file types';
    if (!fitting.length) {
      notice('error', `Sonika Converter cannot work with ${what} yet.`);
      return { action: 'unsupported' };
    }
    if (opts.categoryId) {
      const cat = catOf(opts.categoryId);
      const inCat = fitting.filter((t) => t.category === opts.categoryId);
      if (!inCat.length) {
        hold(paths);
        notice('error', `${cat.label} cannot use ${paths.length === 1 ? 'this file' : 'these files'}. Pick a lit slot.`);
        return { action: 'held' };
      }
      const tool = (opts.tool && inCat.includes(opts.tool)) ? opts.tool : preferredTool(opts.categoryId, inCat);
      const usable = paths.filter((p) => accepts(tool, p));
      if (opts.viaDrop && opts.categoryId === 'audio' && S.settings.instantMode && tool.category === 'audio') {
        clearHeld();
        startJobs(tool, usable, null, true);
        return { action: 'instant', tool: tool.id };
      }
      clearHeld();
      openOptions(tool, usable);
      if (usable.length < paths.length) notice('info', `${plural(paths.length - usable.length, 'file')} skipped: not a type ${tool.label} can use.`);
      return { action: 'options', tool: tool.id };
    }
    if (fitting.length === 1) {
      const tool = fitting[0];
      clearHeld();
      openOptions(tool, paths.filter((p) => accepts(tool, p)));
      return { action: 'options', tool: tool.id };
    }
    hold(paths);
    return { action: 'held' };
  }

  function litFor(paths) {
    const fitting = S.tools.filter((t) => paths.some((p) => accepts(t, p)));
    return { cats: [...new Set(fitting.map((t) => t.category))], filter: (t) => paths.some((p) => accepts(t, p)) };
  }

  function hold(paths) {
    S.held = paths;
    const { cats, filter } = litFor(paths);
    wheel.setLit(cats, filter);
    const curCat = S.categories[wheel.index];
    if (!curCat || !cats.includes(curCat.id)) {
      const first = S.categories.findIndex((c) => cats.includes(c.id));
      if (first >= 0) wheel.select(first);
    }
    const label = paths.length === 1 ? `<b>${esc(base(paths[0]))}</b> is ready` : `<b>${paths.length} files</b> are ready`;
    $('#held-text').innerHTML = `${label}. Pick a lit slot.`;
    $('#held-bar').hidden = false;
    $('#stage-foot').style.visibility = 'hidden';
    wheel.host.focus();
  }

  function clearHeld() {
    S.held = [];
    if (wheel) wheel.setLit(null);
    $('#held-bar').hidden = true;
    $('#stage-foot').style.visibility = 'visible';
  }

  // ------------------------------------------------------------------ drag and drop
  const MIME_EXT = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/webm': '.webm', 'video/x-msvideo': '.avi',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf', 'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tif', 'image/bmp': '.bmp', 'image/heic': '.heic',
  };
  function guessCats(items) {
    const exts = new Set();
    let unknown = false;
    for (const it of items || []) {
      if (it.kind !== 'file') continue;
      const t = (it.type || '').toLowerCase();
      if (MIME_EXT[t]) exts.add(MIME_EXT[t]);
      else if (t.startsWith('video/')) S.tools.forEach((tool) => tool.accepts.forEach((e) => { if (['.mp4', '.mov', '.mkv', '.avi', '.webm', '.mts', '.m4v', '.wmv'].includes(e)) exts.add(e); }));
      else if (t.startsWith('image/')) S.tools.forEach((tool) => tool.accepts.forEach((e) => { if (['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp', '.heic', '.gif'].includes(e)) exts.add(e); }));
      else unknown = true;
    }
    if (unknown || !exts.size) return null; // cannot tell yet: keep every slot lit until the drop
    const cats = new Set();
    for (const t of S.tools) if (t.accepts.some((e) => exts.has(e))) cats.add(t.category);
    return [...cats];
  }

  function bindDrag() {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const stage = $('#stage');
    const start = (e) => {
      if (S.settingsOpen) return;
      if (S.view === 'options') { const dz = $('.dropzone'); if (dz) dz.classList.add('over'); return; }
      stage.classList.add('dragging');
      $('#drop-veil').hidden = false;
      $('#held-bar').hidden = true;
      $('#stage-foot').style.visibility = 'hidden';
      const cats = guessCats(e.dataTransfer.items);
      wheel.setLit(cats);
    };
    const end = () => {
      depth = 0;
      stage.classList.remove('dragging');
      $('#drop-veil').hidden = true;
      const dz = $('.dropzone');
      if (dz) dz.classList.remove('over');
      if (S.held.length) hold(S.held); else { if (wheel) wheel.setLit(null); $('#stage-foot').style.visibility = 'visible'; }
    };
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (depth === 1) start(e);
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = S.settingsOpen ? 'none' : 'copy';
      if (S.view === 'wheel' && !S.settingsOpen) wheel.pointAt(e.clientX, e.clientY);
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth -= 1;
      if (depth <= 0) end();
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => api.pathForFile(f)).filter(Boolean);
      end();
      if (S.settingsOpen) return;
      dropAt(files, e.clientX, e.clientY);
    });
  }

  function dropAt(files, x, y) {
    if (!files.length) return { action: 'none' };
    if (S.view === 'options') { addFilesToSheet(files); return { action: 'added' }; }
    const seg = wheel.segmentAt(x, y, false);
    if (seg >= 0 && S.categories[seg]) return handleFiles(files, { categoryId: S.categories[seg].id, viaDrop: true });
    return handleFiles(files, {});
  }

  // ------------------------------------------------------------------ Flow A: options sheet
  function openOptions(tool, files) {
    S.view = 'options';
    S.tool = tool;
    S.files = (files || []).slice();
    S.options = savedOptions(tool);
    renderSheet();
    const target = $('#sheet-backdrop [data-act="start"]:not(:disabled)') || $('#sheet-backdrop [data-act="pick"]');
    if (target) target.focus();
  }

  function closeSheet() {
    S.view = 'wheel';
    S.tool = null;
    S.files = [];
    const bd = $('#sheet-backdrop');
    bd.hidden = true;
    bd.innerHTML = '';
    wheel.host.focus();
  }

  function optionControl(o, value) {
    const id = `opt-${o.key}`;
    if (o.type === 'toggle') {
      return `<div class="opt"><span class="lbl">${esc(o.label)}</span><div class="toggle-row"><span class="d" style="color:var(--text-3);font-size:12px">${value ? 'On' : 'Off'}</span><button type="button" class="switch" role="switch" aria-label="${esc(o.label)}" aria-checked="${value ? 'true' : 'false'}" data-toggle="${esc(o.key)}"></button></div></div>`;
    }
    if (o.type === 'choice') {
      const choices = o.choices || [];
      const total = choices.reduce((n, c) => n + String(c.label).length, 0);
      if (choices.length <= 4 && total <= 30) {
        return `<div class="opt${choices.length > 2 ? ' wide' : ''}"><span class="lbl" id="${id}-l">${esc(o.label)}</span><div class="seg-ctl" role="radiogroup" aria-labelledby="${id}-l">${choices.map((c) => `<button type="button" role="radio" aria-checked="${c.value === value}" class="${c.value === value ? 'on' : ''}" data-opt="${esc(o.key)}" data-val="${esc(JSON.stringify(c.value))}" title="${esc(c.label)}">${esc(c.label)}</button>`).join('')}</div></div>`;
      }
      return `<div class="opt${total > 60 ? ' wide' : ''}"><label for="${id}">${esc(o.label)}</label><select class="field" id="${id}" data-opt="${esc(o.key)}">${choices.map((c) => `<option value="${esc(JSON.stringify(c.value))}"${c.value === value ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>`;
    }
    if (o.type === 'number') {
      return `<div class="opt"><label for="${id}">${esc(o.label)}</label><input class="field" type="number" id="${id}" data-opt="${esc(o.key)}" data-num="1" value="${esc(value)}"${o.min != null ? ` min="${esc(o.min)}"` : ''}${o.max != null ? ` max="${esc(o.max)}"` : ''}${o.step != null ? ` step="${esc(o.step)}"` : ''}></div>`;
    }
    return `<div class="opt wide"><label for="${id}">${esc(o.label)}</label><input class="field" type="text" id="${id}" data-opt="${esc(o.key)}" value="${esc(value)}" placeholder="${esc(o.placeholder || '')}" spellcheck="false"></div>`;
  }

  function whereText() {
    const s = S.settings;
    if (s.outputMode === 'folder' && s.outputFolder) return `Saves to ${s.outputFolder}`;
    return 'Saves next to each source file';
  }

  function renderSheet() {
    const tool = S.tool;
    if (!tool) return;
    const cat = catOf(tool.category);
    const siblings = toolsIn(tool.category);
    const files = S.files;
    const combine = tool.multi === 'combine';
    const opts = tool.options || [];
    const startLabel = files.length === 0 ? 'Start' : combine ? `Start (${plural(files.length, 'file')})` : files.length === 1 ? 'Start' : `Start ${files.length} files`;
    const fileRows = files.map((p, i) => `
      <div class="file-row" role="listitem">
        ${Icons.svg('file', 16)}
        <span class="name" title="${esc(p)}">${esc(base(p))}</span>
        <span class="dir" title="${esc(dirOf(p))}">${esc(dirOf(p))}</span>
        ${combine && files.length > 1 ? `<button class="icon-btn" data-act="up" data-i="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>${Icons.svg('up', 15)}</button><button class="icon-btn" data-act="down" data-i="${i}" aria-label="Move down"${i === files.length - 1 ? ' disabled' : ''}>${Icons.svg('down', 15)}</button>` : ''}
        <button class="icon-btn" data-act="remove" data-i="${i}" aria-label="Remove ${esc(base(p))}">${Icons.svg('close', 15)}</button>
      </div>`).join('');
    const bd = $('#sheet-backdrop');
    bd.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-head">
          <button class="icon-btn" data-act="back" aria-label="Back to the wheel" title="Back (Esc)">${Icons.svg('back', 19)}</button>
          <div class="tool-tile">${Icons.forTool(tool, 24)}</div>
          <div class="titles">
            <div class="cat">${esc(cat.label)}</div>
            <h2 id="sheet-title">${esc(tool.label)}</h2>
            <p>${esc(tool.hint || cat.hint || '')}</p>
          </div>
        </div>
        <div class="sheet-body">
          ${siblings.length > 1 ? `<div class="tool-switch" role="tablist" aria-label="Tools in ${esc(cat.label)}">${siblings.map((t) => `<button class="chip${t.id === tool.id ? ' on' : ''}" role="tab" aria-selected="${t.id === tool.id}" data-act="switch" data-tool="${esc(t.id)}">${Icons.forTool(t, 14)}${esc(t.label)}</button>`).join('')}</div>` : ''}
          ${opts.length ? `<div class="opts">${opts.map((o) => optionControl(o, S.options[o.key])).join('')}</div>` : ''}
          ${files.length ? `<div class="files-head"><span>${plural(files.length, 'file')}${combine && files.length > 1 ? ' - combined in this order' : ''}</span><button class="btn btn-sm btn-ghost" data-act="clear-files">Remove all</button></div><div class="files" role="list">${fileRows}</div>` : ''}
          <div class="dropzone${files.length ? ' compact' : ''}">
            <div class="dz-icon">${Icons.svg(files.length ? 'plus' : 'drop', files.length ? 18 : 22)}</div>
            <div class="dz-text">
              <div class="dz-title">${files.length ? 'Add more files' : 'Drop files here'}</div>
              <div class="dz-sub" title="${esc(typesText(tool))}">${esc(typesText(tool))}</div>
            </div>
            <button class="btn" data-act="pick">Choose files</button>
          </div>
          ${combine ? `<div class="combine-note">All files are combined into one result.</div>` : ''}
        </div>
        <div class="sheet-foot">
          <div class="where">${Icons.svg('folder', 15)}<span title="${esc(whereText())}">${esc(whereText())}</span></div>
          <button class="btn btn-ghost" data-act="back">Cancel</button>
          <button class="btn btn-primary btn-lg" data-act="start"${files.length ? '' : ' disabled'}>${esc(startLabel)}</button>
        </div>
      </div>`;
    bd.hidden = false;
  }

  let saveTimer = null;
  function rememberOptions() {
    const tool = S.tool;
    if (!tool) return;
    S.settings.toolOptions = S.settings.toolOptions || {};
    S.settings.toolOptions[tool.id] = { ...S.options };
    clearTimeout(saveTimer);
    const opts = { ...S.options };
    saveTimer = setTimeout(() => api.saveToolOptions(tool.id, opts), 200);
  }

  function addFilesToSheet(paths) {
    const tool = S.tool;
    if (!tool) return;
    const ok = paths.filter((p) => accepts(tool, p));
    const bad = paths.length - ok.length;
    const set = new Set(S.files);
    for (const p of ok) set.add(p);
    S.files = [...set];
    renderSheet();
    if (bad) notice('error', `${plural(bad, 'file')} skipped: ${tool.label} takes ${typesText(tool)}.`);
  }

  async function startJobs(tool, files, options, instant) {
    const res = await api.startJobs({ toolId: tool.id, files, options: options || undefined });
    if (!res || !res.ok) { notice('error', (res && res.message) || 'Could not start.'); return res; }
    const n = res.jobIds.length;
    const what = tool.multi === 'combine' ? plural(files.length, 'file') : plural(n, 'file');
    notice('success', `${instant ? 'Instant: ' : ''}${tool.label} started for ${what}.${res.message ? ' ' + res.message : ''}`);
    return res;
  }

  function bindSheet() {
    const bd = $('#sheet-backdrop');
    bd.addEventListener('mousedown', (e) => { if (e.target === bd) closeSheet(); });
    bd.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act], [data-toggle], .seg-ctl button[data-opt]');
      if (!b) return;
      if (b.dataset.toggle) {
        const key = b.dataset.toggle;
        S.options[key] = !S.options[key];
        rememberOptions();
        renderSheet();
        const again = bd.querySelector(`[data-toggle="${CSS.escape(key)}"]`);
        if (again) again.focus();
        return;
      }
      if (b.dataset.opt && b.dataset.val != null) {
        S.options[b.dataset.opt] = JSON.parse(b.dataset.val);
        rememberOptions();
        const grp = b.parentElement;
        $$('button', grp).forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        return;
      }
      const act = b.dataset.act;
      const i = Number(b.dataset.i);
      if (act === 'back') closeSheet();
      else if (act === 'pick') { const files = await api.pickFiles(S.tool.id); if (files && files.length) addFilesToSheet(files); }
      else if (act === 'remove') { S.files.splice(i, 1); renderSheet(); }
      else if (act === 'clear-files') { S.files = []; renderSheet(); }
      else if (act === 'up' && i > 0) { [S.files[i - 1], S.files[i]] = [S.files[i], S.files[i - 1]]; renderSheet(); }
      else if (act === 'down' && i < S.files.length - 1) { [S.files[i + 1], S.files[i]] = [S.files[i], S.files[i + 1]]; renderSheet(); }
      else if (act === 'switch') {
        const t = toolById(b.dataset.tool);
        if (t && t !== S.tool) {
          const keep = S.files.filter((p) => accepts(t, p));
          const dropped = S.files.length - keep.length;
          openOptions(t, keep);
          api.setLastTool(t.category, t.id);
          S.settings.lastTool = { ...(S.settings.lastTool || {}), [t.category]: t.id };
          if (dropped) notice('info', `${plural(dropped, 'file')} removed: ${t.label} takes ${typesText(t)}.`);
          const chip = bd.querySelector(`[data-tool="${CSS.escape(t.id)}"]`);
          if (chip) chip.focus();
        }
      } else if (act === 'start') startFromSheet();
    });
    bd.addEventListener('change', (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.opt) return;
      if (el.tagName === 'SELECT') S.options[el.dataset.opt] = JSON.parse(el.value);
      else if (el.dataset.num) { const v = Number(el.value); if (Number.isFinite(v)) S.options[el.dataset.opt] = v; }
      else S.options[el.dataset.opt] = el.value;
      rememberOptions();
    });
    bd.addEventListener('input', (e) => {
      const el = e.target;
      if (el.tagName !== 'INPUT' || !el.dataset.opt) return;
      if (el.dataset.num) { const v = Number(el.value); if (el.value !== '' && Number.isFinite(v)) S.options[el.dataset.opt] = v; }
      else S.options[el.dataset.opt] = el.value;
      rememberOptions();
    });
  }

  async function startFromSheet() {
    const tool = S.tool;
    if (!tool || !S.files.length) return null;
    const res = await startJobs(tool, S.files.slice(), { ...S.options });
    if (res && res.ok) closeSheet();
    return res;
  }

  // ------------------------------------------------------------------ jobs
  function badge(job) {
    switch (job.status) {
      case 'queued': return 'Waiting';
      case 'running': return job.progress > 0 ? `${Math.round(job.progress * 100)}%` : 'Working';
      case 'cancelling': return 'Stopping';
      case 'done': return 'Done';
      case 'error': return 'Failed';
      case 'cancelled': return 'Cancelled';
      default: return '';
    }
  }

  function statusLine(job) {
    if (job.status === 'done') {
      const n = (job.outputs || []).length;
      if (job.message && !/^done\.?$/i.test(job.message)) return job.message;
      if (n === 1) return `Saved ${base(job.outputs[0])}`;
      if (n > 1) return `Saved ${n} files`;
      return 'Done';
    }
    if (job.status === 'error') return '';
    if (job.status === 'queued') return 'Waiting for a free slot';
    return job.statusText || '';
  }

  function jobHtml(job) {
    const tool = toolById(job.toolId) || { id: job.toolId, category: job.category };
    const active = job.status === 'running' || job.status === 'queued' || job.status === 'cancelling';
    const hasOut = job.status === 'done' && job.outputs && job.outputs.length;
    const isText = typeof job.text === 'string' && job.text.length > 0;
    const canRetry = (job.status === 'error' || job.status === 'cancelled') && toolById(job.toolId);
    const line = statusLine(job);
    const outTitle = hasOut ? job.outputs.join('\n') : line;
    let inline = '';
    if (active && job.status !== 'cancelling') inline = `<button class="btn btn-sm btn-ghost btn-danger btn-inline" data-job="cancel">${Icons.svg('stop', 13)}Cancel</button>`;
    else if (job.status === 'cancelled' && canRetry) inline = `<button class="btn btn-sm btn-inline" data-job="retry">Try again</button>`;
    return `
      <div class="job-top">
        <div class="job-ico">${job.status === 'error' ? Icons.svg('alert', 17) : Icons.forTool(tool, 17)}</div>
        <div class="job-main">
          <div class="job-title" title="${esc(job.inputs.join('\n'))}">${esc(job.title)}</div>
          <div class="job-sub">${esc(job.toolLabel)}</div>
        </div>
        <div class="job-badge">${job.status === 'done' ? Icons.svg('check', 13) : ''}${esc(badge(job))}</div>
      </div>
      ${active ? `<div class="job-bar"><i style="width:${Math.round((job.progress || 0) * 100)}%"></i></div>` : ''}
      ${job.status !== 'error' ? `<div class="job-line"><div class="job-status" title="${esc(outTitle)}">${esc(line)}</div>${inline}</div>` : ''}
      ${job.status === 'error' ? `<div class="job-error">${esc(job.error || 'Something went wrong.')}</div>` : ''}
      ${isText ? `<div class="transcript-head"><span>TRANSCRIPT</span><button class="btn btn-sm btn-inline" data-job="copy">${Icons.svg('copy', 13)}Copy text</button></div><div class="transcript" tabindex="0" aria-label="Transcript">${esc(job.text)}</div>` : ''}
      ${hasOut ? `<div class="job-actions"><button class="btn btn-sm" data-job="show">${Icons.svg('folder', 14)}Show in folder</button><button class="btn btn-sm btn-ghost" data-job="open">${Icons.svg('open', 14)}Open</button></div>` : ''}
      ${job.status === 'error' && canRetry ? `<div class="job-actions"><button class="btn btn-sm" data-job="retry">Try again</button></div>` : ''}`;
  }

  function jobEl(job) {
    const el = document.createElement('div');
    el.className = `job ${job.status}`;
    el.dataset.id = job.id;
    el.dataset.status = job.status;
    el.setAttribute('role', 'listitem');
    el.innerHTML = jobHtml(job);
    return el;
  }

  function upsertJob(job) {
    S.jobs.set(job.id, job);
    const list = $('#queue-list');
    const empty = $('.queue-empty', list);
    if (empty) empty.remove();
    let el = list.querySelector(`.job[data-id="${CSS.escape(job.id)}"]`);
    if (!el) {
      el = jobEl(job);
      list.prepend(el);
    } else if (el.dataset.status !== job.status) {
      const fresh = jobEl(job);
      fresh.style.animation = 'none';
      el.replaceWith(fresh);
    } else {
      const bar = $('.job-bar i', el);
      if (bar) bar.style.width = `${Math.round((job.progress || 0) * 100)}%`;
      const b = $('.job-badge', el);
      if (b) b.textContent = badge(job);
      const st = $('.job-status', el);
      if (st) { st.textContent = statusLine(job); st.title = statusLine(job); }
    }
    updateQueueHead();
  }

  function renderJobs() {
    const list = $('#queue-list');
    list.innerHTML = '';
    const jobs = [...S.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const j of jobs) list.prepend(jobEl(j));
    updateQueueHead();
  }

  function updateQueueHead() {
    const jobs = [...S.jobs.values()];
    const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'cancelling').length;
    const finished = jobs.length - running;
    const waiting = jobs.filter((j) => j.status === 'queued').length;
    $('#queue-count').textContent = running ? (waiting ? `${running - waiting} running, ${waiting} waiting` : `${running} running`) : jobs.length ? `${jobs.length}` : '';
    $('#btn-clear').hidden = finished === 0;
    const list = $('#queue-list');
    if (!jobs.length && !$('.queue-empty', list)) {
      list.innerHTML = `<div class="queue-empty">${Icons.svg('clock', 40)}<b>No jobs yet</b>Pick a tool on the wheel, or drop files anywhere on this window.</div>`;
    }
  }

  function bindJobs() {
    $('#queue-list').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-job]');
      if (!b) return;
      const id = b.closest('.job').dataset.id;
      const act = b.dataset.job;
      if (act === 'cancel') api.cancelJob(id);
      else if (act === 'show') { const r = await api.showOutput(id); if (r && !r.ok) notice('error', r.message); }
      else if (act === 'open') { const r = await api.openOutput(id); if (r && !r.ok) notice('error', r.message || 'Windows could not open this file.'); }
      else if (act === 'copy') { const r = await api.copyText(id); if (r && r.ok) { notice('success', 'Transcript copied.'); b.innerHTML = Icons.svg('check', 13) + 'Copied'; setTimeout(() => { if (b.isConnected) b.innerHTML = Icons.svg('copy', 13) + 'Copy text'; }, 1600); } }
      else if (act === 'retry') {
        const job = S.jobs.get(id);
        const tool = job && toolById(job.toolId);
        if (tool) startJobs(tool, job.inputs, null);
      }
    });
    $('#btn-clear').addEventListener('click', () => api.clearFinished());
  }

  // ------------------------------------------------------------------ settings
  function keycaps(accel) {
    return String(accel || '').split('+').filter(Boolean).map((k) => `<span class="kc">${esc(k)}</span>`).join('<span style="color:var(--text-3)">+</span>');
  }

  function toolStatusHtml(key, label, purpose) {
    const d = S.detect[key] || { ok: false, message: 'Not checked yet.' };
    return `
      <div class="tool-status ${d.ok ? 'ok' : 'bad'}" data-tool-status="${key}">
        <div class="state">${Icons.svg(d.ok ? 'check' : 'alert', 15)}</div>
        <div class="info"><div class="name">${esc(label)} <span style="color:var(--text-3);font-weight:400;font-size:11.5px">- ${esc(purpose)}</span></div>
          <div class="p" title="${esc(d.path || d.message)}">${esc(d.ok ? d.path : d.message)}</div></div>
        <button class="btn btn-sm" data-set="browse-${key}">Browse</button>
      </div>`;
  }

  function switchRow(key, title, desc) {
    const on = !!S.settings[key];
    return `<div class="set-row"><div class="grow"><div class="t" id="sw-${key}">${esc(title)}</div><div class="d">${esc(desc)}</div></div>
      <button type="button" class="switch" role="switch" aria-labelledby="sw-${key}" aria-checked="${on}" data-switch="${key}"></button></div>`;
  }

  let hotkeyMsg = null;
  function renderSettings() {
    const s = S.settings;
    const hk = S.hotkey || {};
    const folderSet = !!s.outputFolder;
    const errs = (S.loadErrors || []).filter((e) => e.module !== 'test-inject');
    const msg = hotkeyMsg || (hk.message ? { ok: hk.ok, info: hk.ok, text: hk.message } : null);
    $('#settings').innerHTML = `
      <aside class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="settings-head"><h2 id="settings-title">Settings</h2>
          <button class="icon-btn" data-set="close" aria-label="Close settings" title="Close (Esc)">${Icons.svg('close', 18)}</button></div>
        <div class="settings-body">
          <section class="set-section"><h3>OUTPUT LOCATION</h3>
            <label class="radio"><input type="radio" name="outmode" value="source"${s.outputMode !== 'folder' ? ' checked' : ''}>
              <span><span class="t">Next to the source file</span><span class="path">The converted file lands beside the original.</span></span></label>
            <label class="radio"><input type="radio" name="outmode" value="folder"${s.outputMode === 'folder' ? ' checked' : ''}${folderSet ? '' : ' data-needs-folder="1"'}>
              <span style="min-width:0"><span class="t">One fixed folder</span><span class="path" title="${esc(s.outputFolder || '')}">${esc(folderSet ? s.outputFolder : 'No folder chosen yet')}</span></span></label>
            <div style="padding-left:35px;margin-top:4px"><button class="btn btn-sm" data-set="browse-folder">${Icons.svg('folder', 14)}Choose folder</button></div>
          </section>
          <section class="set-section"><h3>HELPER PROGRAMS</h3>
            ${toolStatusHtml('handy', 'Handy', 'transcripts')}
            ${toolStatusHtml('ffmpeg', 'FFmpeg', 'audio and video')}
          </section>
          <section class="set-section"><h3>WHEEL SHORTCUT</h3>
            <div class="set-row">
              <div class="hotkey-box" id="hotkey-box">${keycaps(hk.accelerator || s.hotkey)}</div>
              <button class="btn" data-set="hotkey">Change</button>
            </div>
            <div class="d" style="color:var(--text-3);font-size:11.5px;margin-top:8px">Press it anywhere in Windows to pop the wheel over your work.</div>
            ${msg && msg.text ? `<div class="msg ${msg.info ? 'info' : msg.ok ? 'ok' : 'err'}" id="hotkey-msg">${esc(msg.text)}</div>` : ''}
          </section>
          <section class="set-section"><h3>BEHAVIOUR</h3>
            ${switchRow('instantMode', 'Instant mode', 'Dropping a video straight onto the AUDIO slot starts at once with your saved options.')}
            ${switchRow('closeToTray', 'Close button hides to tray', 'Keeps the app and the shortcut ready in the background.')}
            ${switchRow('startWithWindows', 'Start with Windows', 'So the shortcut always works. Starts quietly in the tray.')}
          </section>
          <section class="set-section"><h3>ABOUT</h3>
            <div class="about"><img src="../../assets/png/icon-128.png" alt=""><div><div class="n">Sonika Converter</div><div class="v">Version ${esc(S.version)} - works fully offline</div></div></div>
            ${errs.length ? `<div class="load-warn">Some tools could not load yet: ${esc(errs.map((e) => e.module).join(', '))}. Everything else works.</div>` : ''}
          </section>
        </div>
      </aside>`;
  }

  function openSettings() {
    S.settingsOpen = true;
    hotkeyMsg = null;
    renderSettings();
    $('#settings').hidden = false;
    api.detect().then((d) => { S.detect = d; if (S.settingsOpen && !recording) renderSettings(); updateWarnDot(); });
    const c = $('#settings [data-set="close"]');
    if (c) c.focus();
  }

  function closeSettings() {
    if (recording) stopRecording(false);
    S.settingsOpen = false;
    $('#settings').hidden = true;
    $('#btn-settings').focus();
  }

  let recording = false;
  const CODE_KEYS = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  function accelFromEvent(e) {
    let key = null;
    const c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
    else if (/^Digit[0-9]$/.test(c)) key = c.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) key = c;
    else if (/^Numpad[0-9]$/.test(c)) key = 'num' + c.slice(6);
    else if (CODE_KEYS[c]) key = CODE_KEYS[c];
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const fkey = /^F\d+$/.test(key);
    if (!fkey && !mods.some((m) => m !== 'Shift')) return { error: 'Use at least Ctrl, Alt or the Windows key with another key.' };
    return { accel: [...mods, key].join('+') };
  }

  function startRecording() {
    recording = true;
    hotkeyMsg = null;
    api.suspendHotkey(true);
    const box = $('#hotkey-box');
    box.classList.add('recording');
    box.innerHTML = '<span class="rec">Press the new shortcut... (Esc to cancel)</span>';
    const btn = $('#settings [data-set="hotkey"]');
    if (btn) btn.textContent = 'Cancel';
  }

  async function stopRecording(accel) {
    recording = false;
    if (accel) {
      const r = await api.setHotkey(accel);
      S.hotkey = r.hotkey || S.hotkey;
      hotkeyMsg = { ok: r.ok, text: r.message };
    } else {
      await api.suspendHotkey(false);
    }
    updateWarnDot();
    if (S.settingsOpen) renderSettings();
  }

  async function settingsAction(act) {
    if (act === 'close') closeSettings();
    else if (act === 'browse-folder') {
      const r = await api.browse('outputFolder');
      if (r && r.ok) { S.settings = r.settings; S.detect = r.detect; renderSettings(); }
    } else if (act === 'browse-handy' || act === 'browse-ffmpeg') {
      const r = await api.browse(act.slice(7));
      if (r && r.ok) { S.settings = r.settings; S.detect = r.detect; renderSettings(); updateWarnDot(); }
    } else if (act === 'hotkey') {
      if (recording) stopRecording(false); else startRecording();
    }
  }

  async function updateSetting(patch) {
    const r = await api.updateSettings(patch);
    if (r && r.ok) { S.settings = r.settings; S.detect = r.detect || S.detect; }
    if (S.settingsOpen) renderSettings();
    return r;
  }

  function bindSettings() {
    $('#btn-settings').addEventListener('click', () => (S.settingsOpen ? closeSettings() : openSettings()));
    const root = $('#settings');
    root.addEventListener('mousedown', (e) => { if (e.target === root) closeSettings(); });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-set], [data-switch]');
      if (!b) return;
      if (b.dataset.switch) {
        const key = b.dataset.switch;
        await updateSetting({ [key]: !S.settings[key] });
        const again = $(`#settings [data-switch="${key}"]`);
        if (again) again.focus();
        return;
      }
      settingsAction(b.dataset.set);
    });
    root.addEventListener('change', async (e) => {
      if (e.target.name !== 'outmode') return;
      if (e.target.value === 'folder' && !S.settings.outputFolder) {
        const r = await api.browse('outputFolder');
        if (r && r.ok) { S.settings = r.settings; renderSettings(); } else renderSettings();
        return;
      }
      updateSetting({ outputMode: e.target.value });
    });
    document.addEventListener('keydown', (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stopRecording(false); return; }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
        $('#hotkey-box').innerHTML = keycaps(mods.join('+') + '+') || '<span class="rec">Press the new shortcut...</span>';
        return;
      }
      const r = accelFromEvent(e);
      if (!r) return;
      if (r.error) { hotkeyMsg = { ok: false, text: r.error }; $('#hotkey-box').innerHTML = `<span class="rec">${esc(r.error)}</span>`; return; }
      stopRecording(r.accel);
    }, true);
  }

  // ------------------------------------------------------------------ keyboard
  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (recording) return;
      if (e.key === 'Escape') {
        if (S.settingsOpen) { closeSettings(); e.preventDefault(); return; }
        if (S.view === 'options') { closeSheet(); e.preventDefault(); return; }
        if (S.held.length) { clearHeld(); e.preventDefault(); return; }
      }
      if (e.ctrlKey && e.key === ',') { S.settingsOpen ? closeSettings() : openSettings(); e.preventDefault(); return; }
      if (S.view === 'options' && e.ctrlKey && e.key === 'Enter') { startFromSheet(); e.preventDefault(); return; }
      // Typing on the empty page drives the wheel.
      const a = document.activeElement;
      if (S.view === 'wheel' && !S.settingsOpen && (!a || a === document.body)) {
        wheel.host.focus();
        wheel.onKey(e);
      }
    });
  }

  // ------------------------------------------------------------------ events from main
  function bindEvents() {
    api.on('job', (job) => upsertJob(job));
    api.on('jobs', (jobs) => { S.jobs = new Map(jobs.map((j) => [j.id, j])); renderJobs(); });
    api.on('settings', (s) => { S.settings = s; if (S.settingsOpen && !recording) renderSettings(); });
    api.on('registry', (r) => {
      S.categories = r.categories; S.tools = r.tools; S.loadErrors = r.loadErrors;
      wheel.setData(S.categories, S.tools, S.settings.lastTool || {});
    });
    api.on('files-incoming', (p) => {
      if (S.settingsOpen) closeSettings();
      if (S.view === 'options') closeSheet();
      handleFiles(p.files || [], {});
    });
    api.on('notice', (n) => notice(n.kind || 'info', n.text));
  }

  // ------------------------------------------------------------------ boot
  async function init() {
    applyState(await api.getState());
    $('#btn-settings').innerHTML = Icons.svg('gear', 19);
    buildWheel();
    bindDrag();
    bindSheet();
    bindJobs();
    bindSettings();
    bindKeys();
    bindEvents();
    renderJobs();
    wheel.host.focus();
    document.body.dataset.ready = '1';
  }

  // Test and automation surface (main world only; the preload API stays narrow).
  window.SonikaApp = {
    S,
    get wheel() { return wheel; },
    handleFiles, dropAt, openOptions, closeSheet, startFromSheet, addFilesToSheet, clearHeld,
    openSettings, closeSettings, updateSetting,
    segmentPoint(i, radius) {
      const c = wheel.center();
      const a = ((-90 + i * 60) * Math.PI) / 180;
      const r = (radius || 224) * wheel.scale;
      return { x: Math.round(c.x + r * Math.cos(a)), y: Math.round(c.y + r * Math.sin(a)) };
    },
  };

  init();
})();
