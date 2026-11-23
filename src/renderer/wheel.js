'use strict';
// Radial selection wheel: 6 wedge slots around a hub. Selection follows the pointer's angle from the
// centre; the mouse wheel or Left/Right cycles tools inside the highlighted slot; click or Enter picks.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const SIZE = 600;          // design size; the whole wheel is scaled to fit its host
  const R_OUT = 288;
  const R_IN = 152;
  const GAP = 4.5;           // half gap in px between wedges (parallel edges)
  const PUSH = 9;            // how far the selected wedge moves outward
  const DEAD_ZONE = 64;      // pointer this close to the centre keeps the current selection

  const deg = (d) => (d * Math.PI) / 180;
  const f = (n) => Number(n.toFixed(2));

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function wedgePath(center) {
    const half = 30;
    const dOut = (Math.asin(GAP / R_OUT) * 180) / Math.PI;
    const dIn = (Math.asin(GAP / R_IN) * 180) / Math.PI;
    const a0o = deg(center - half + dOut); const a1o = deg(center + half - dOut);
    const a0i = deg(center - half + dIn); const a1i = deg(center + half - dIn);
    const p = (r, a) => `${f(r * Math.cos(a))} ${f(r * Math.sin(a))}`;
    return `M ${p(R_IN, a0i)} L ${p(R_OUT, a0o)} A ${R_OUT} ${R_OUT} 0 0 1 ${p(R_OUT, a1o)} L ${p(R_IN, a1i)} A ${R_IN} ${R_IN} 0 0 0 ${p(R_IN, a0i)} Z`;
  }

  function rimPath(center) {
    const r = R_OUT - 3;
    const d = (Math.asin((GAP + 10) / r) * 180) / Math.PI;
    const a0 = deg(center - 30 + d); const a1 = deg(center + 30 - d);
    return `M ${f(r * Math.cos(a0))} ${f(r * Math.sin(a0))} A ${r} ${r} 0 0 1 ${f(r * Math.cos(a1))} ${f(r * Math.sin(a1))}`;
  }

  class Wheel {
    /**
     * opts: { categories, tools, lastTool: {catId: toolId}, pointerArea: Element, onPick(tool, cat),
     *         onChange(state), onOutsideClick(), allowOutsideClickPick: false }
     */
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.categories = [];
      this.tools = [];
      this.toolIdx = {};       // catId -> index into that category's tools
      this.index = 0;          // selected slot
      this.lit = null;         // Set of catIds that may be chosen (Flow B), or null for all
      this.scale = 1;
      this.wheelAccum = 0;
      this.lastWheelStep = 0;
      this.build();
      this.setData(opts.categories || [], opts.tools || [], opts.lastTool || {});
      this.bind();
    }

    build() {
      this.host.classList.add('wheel');
      this.host.setAttribute('tabindex', '0');
      this.host.setAttribute('role', 'listbox');
      this.host.setAttribute('aria-label', 'Converter wheel. Arrow keys or 1 to 6 to choose a slot, Left and Right to switch tool, Enter to pick.');
      this.scaler = document.createElement('div');
      this.scaler.className = 'wheel-scaler';
      this.host.appendChild(this.scaler);
      this.svg = el('svg', { viewBox: `${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`, width: SIZE, height: SIZE, class: 'wheel-svg', 'aria-hidden': 'true' }, this.scaler);
      el('circle', { cx: 0, cy: 0, r: R_OUT + 6, class: 'wheel-backplate' }, this.svg);
      this.segLayer = el('g', {}, this.svg);
      this.hub = document.createElement('div');
      this.hub.className = 'hub';
      this.hub.innerHTML = `
        <div class="hub-inner">
          <div class="hub-cat"><span class="hub-cat-name"></span><span class="hub-count"></span></div>
          <div class="hub-icon"></div>
          <div class="hub-tool"></div>
          <div class="hub-hint"></div>
          <div class="hub-pips" aria-hidden="true"></div>
          <div class="hub-cycle"><span class="kc">&#8592;</span><span class="hub-cycle-text">Scroll to switch</span><span class="kc">&#8594;</span></div>
        </div>`;
      this.scaler.appendChild(this.hub);
      this.live = document.createElement('div');
      this.live.className = 'sr-only';
      this.live.setAttribute('aria-live', 'polite');
      this.host.appendChild(this.live);
      this.ro = new ResizeObserver(() => this.fit());
      this.ro.observe(this.host);
    }

    setData(categories, tools, lastTool) {
      this.categories = categories.slice(0, 6);
      this.tools = tools.slice();
      lastTool = lastTool || {};
      for (const c of this.categories) {
        const list = this.toolsIn(c.id);
        let i = list.findIndex((t) => t.id === lastTool[c.id]);
        if (i < 0 && this.toolIdx[c.id] != null && this.toolIdx[c.id] < list.length) i = this.toolIdx[c.id];
        if (i < 0) i = Math.max(0, list.findIndex((t) => t.isDefault));
        this.toolIdx[c.id] = i;
      }
      this.renderSegments();
      this.update(false);
    }

    toolsIn(catId) {
      // Registry order inside a slot, default tool first.
      const list = this.tools.filter((t) => t.category === catId);
      return list.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    }

    renderSegments() {
      this.segLayer.textContent = '';
      this.segs = this.categories.map((cat, i) => {
        const center = -90 + i * 60;
        const g = el('g', { class: 'seg', 'data-cat': cat.id, 'data-index': i }, this.segLayer);
        el('path', { d: wedgePath(center), class: 'seg-shape' }, g);
        el('path', { d: rimPath(center), class: 'seg-rim' }, g);
        const mid = (R_IN + R_OUT) / 2 + 4;
        const cx = mid * Math.cos(deg(center));
        const cy = mid * Math.sin(deg(center));
        const content = el('g', { class: 'seg-content', transform: `translate(${f(cx)} ${f(cy)})` }, g);
        const icon = el('g', { class: 'seg-icon', transform: 'translate(-17 -38) scale(1.42)' }, content);
        icon.innerHTML = window.Icons.raw(cat.id);
        const label = el('text', { class: 'seg-label', x: 0, y: 14, 'text-anchor': 'middle' }, content);
        label.textContent = cat.label;
        const pips = el('g', { class: 'seg-pips', transform: 'translate(0 32)' }, content);
        const keyR = R_OUT - 22;
        const kx = keyR * Math.cos(deg(center - 21));
        const ky = keyR * Math.sin(deg(center - 21));
        const key = el('text', { class: 'seg-key', x: f(kx), y: f(ky + 4), 'text-anchor': 'middle' }, g);
        key.textContent = String(i + 1);
        return { g, pips, cat, center };
      });
      this.renderPips();
    }

    renderPips() {
      for (const s of this.segs) {
        const list = this.toolsIn(s.cat.id);
        s.pips.textContent = '';
        const n = list.length;
        const gap = 10;
        const x0 = -((n - 1) * gap) / 2;
        for (let k = 0; k < n; k += 1) {
          el('circle', { cx: f(x0 + k * gap), cy: 0, r: 2.6, class: 'pip' + (k === this.toolIdx[s.cat.id] ? ' on' : '') }, s.pips);
        }
        s.g.classList.toggle('empty', n === 0);
      }
    }

    fit() {
      const r = this.host.getBoundingClientRect();
      const avail = Math.min(r.width, r.height);
      const max = this.opts.maxScale || 1.12;
      this.scale = Math.max(0.4, Math.min(max, avail / SIZE));
      this.scaler.style.transform = `translate(-50%, -50%) scale(${this.scale})`;
    }

    bind() {
      const area = this.opts.pointerArea || this.host;
      this.area = area;
      const ok = (e) => !this.opts.guard || this.opts.guard(e);
      area.addEventListener('pointermove', (e) => { if (ok(e)) this.pointAt(e.clientX, e.clientY); });
      area.addEventListener('wheel', (e) => {
        if (!ok(e)) return;
        e.preventDefault();
        this.onWheel(e.deltaY || e.deltaX);
      }, { passive: false });
      area.addEventListener('click', (e) => {
        if (!ok(e) || e.button !== 0) return;
        const d = this.distance(e.clientX, e.clientY);
        if (d <= (R_OUT + 8) * this.scale) {
          if (d > DEAD_ZONE * this.scale) this.pointAt(e.clientX, e.clientY);
          this.pick();
        } else if (this.opts.onOutsideClick) {
          this.opts.onOutsideClick(e);
        }
      });
      this.host.addEventListener('keydown', (e) => this.onKey(e));
    }

    center() {
      const r = this.host.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    distance(x, y) {
      const c = this.center();
      return Math.hypot(x - c.x, y - c.y);
    }

    /** Slot index under a screen point, -1 when in the hub or outside the ring. */
    segmentAt(x, y, anyDistance) {
      const c = this.center();
      const dx = x - c.x; const dy = y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < DEAD_ZONE * this.scale) return -1;
      if (!anyDistance && d > (R_OUT + 8) * this.scale) return -1;
      let a = (Math.atan2(dy, dx) * 180) / Math.PI + 90 + 30; // 0 = start of slot 0
      a = ((a % 360) + 360) % 360;
      return Math.floor(a / 60) % 6;
    }

    pointAt(x, y) {
      const i = this.segmentAt(x, y, true);
      if (i < 0 || i >= this.categories.length) return;
      this.select(i);
    }

    selectable(i) {
      const cat = this.categories[i];
      return !!cat && (!this.lit || this.lit.has(cat.id));
    }

    select(i, fromKey) {
      if (i < 0 || i >= this.categories.length) return;
      if (i === this.index && this.hasSelection) return;
      this.index = i;
      this.hasSelection = true;
      this.update(true);
      if (fromKey) this.announce();
    }

    step(dir) {
      const n = this.categories.length;
      if (!n) return;
      this.select(((this.index + dir) % n + n) % n, true);
    }

    cycle(dir) {
      const cat = this.categories[this.index];
      if (!cat) return;
      const list = this.visibleToolsIn(cat.id);
      if (list.length < 2) { this.nudge(); return; }
      const all = this.toolsIn(cat.id);
      const current = all[this.toolIdx[cat.id]];
      let pos = list.indexOf(current);
      pos = ((pos + dir) % list.length + list.length) % list.length;
      this.toolIdx[cat.id] = all.indexOf(list[pos]);
      this.update(true, dir);
      this.announce();
    }

    /** Tools in a slot that can be cycled to (all, or only those that fit dropped files). */
    visibleToolsIn(catId) {
      const all = this.toolsIn(catId);
      if (!this.toolFilter) return all;
      const fit = all.filter(this.toolFilter);
      return fit.length ? fit : all;
    }

    setLit(set, toolFilter) {
      this.lit = set ? new Set(set) : null;
      this.toolFilter = toolFilter || null;
      if (this.toolFilter) {
        for (const c of this.categories) {
          const all = this.toolsIn(c.id);
          const cur = all[this.toolIdx[c.id]];
          if (cur && !this.toolFilter(cur)) {
            const fit = all.findIndex(this.toolFilter);
            if (fit >= 0) this.toolIdx[c.id] = fit;
          }
        }
      }
      this.update(false);
    }

    onWheel(delta) {
      const now = performance.now();
      this.wheelAccum += delta;
      // One step per notch on a mouse; touchpads send many small deltas, so accumulate.
      if (Math.abs(this.wheelAccum) >= 40 && now - this.lastWheelStep > 70) {
        this.cycle(this.wheelAccum > 0 ? 1 : -1);
        this.wheelAccum = 0;
        this.lastWheelStep = now;
      }
      clearTimeout(this.wheelReset);
      this.wheelReset = setTimeout(() => { this.wheelAccum = 0; }, 160);
    }

    onKey(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (k === 'ArrowRight') { this.cycle(1); e.preventDefault(); }
      else if (k === 'ArrowLeft') { this.cycle(-1); e.preventDefault(); }
      else if (k === 'ArrowDown') { this.step(1); e.preventDefault(); }
      else if (k === 'ArrowUp') { this.step(-1); e.preventDefault(); }
      else if (/^[1-6]$/.test(k)) { this.select(Number(k) - 1, true); e.preventDefault(); }
      else if (k === 'Enter' || k === ' ') { this.pick(); e.preventDefault(); }
    }

    currentTool() {
      const cat = this.categories[this.index];
      if (!cat) return null;
      const list = this.toolsIn(cat.id);
      return list[this.toolIdx[cat.id]] || null;
    }

    pick() {
      const cat = this.categories[this.index];
      const tool = this.currentTool();
      if (!cat || !tool || !this.selectable(this.index)) { this.nudge(); return; }
      const s = this.segs[this.index];
      s.g.classList.remove('picked');
      void s.g.getBoundingClientRect();
      s.g.classList.add('picked');
      if (this.opts.onPick) this.opts.onPick(tool, cat);
    }

    nudge() {
      this.hub.classList.remove('nudge');
      void this.hub.offsetWidth;
      this.hub.classList.add('nudge');
    }

    announce() {
      const cat = this.categories[this.index];
      const tool = this.currentTool();
      this.live.textContent = cat ? `${cat.label}: ${tool ? tool.label : 'no tools yet'}` : '';
    }

    update(animate, dir) {
      if (!this.segs) return;
      this.segs.forEach((s, i) => {
        const sel = i === this.index;
        const dim = !!this.lit && !this.lit.has(s.cat.id);
        s.g.classList.toggle('selected', sel);
        s.g.classList.toggle('dim', dim);
        s.g.classList.toggle('lit', !!this.lit && !dim);
        const push = sel && !dim ? PUSH : 0;
        s.g.style.transform = `translate(${f(push * Math.cos(deg(s.center)))}px, ${f(push * Math.sin(deg(s.center)))}px)`;
      });
      this.renderPips();
      const cat = this.categories[this.index];
      const tool = this.currentTool();
      const list = cat ? this.toolsIn(cat.id) : [];
      const q = (sel) => this.hub.querySelector(sel);
      const dim = cat && this.lit && !this.lit.has(cat.id);
      this.hub.classList.toggle('dim', !!dim);
      q('.hub-cat-name').textContent = cat ? cat.label : '';
      q('.hub-count').textContent = list.length > 1 ? `${this.toolIdx[cat.id] + 1} / ${list.length}` : '';
      q('.hub-icon').innerHTML = tool ? window.Icons.forTool(tool, 34) : (cat ? window.Icons.svg(cat.id, 34) : '');
      q('.hub-tool').textContent = dim ? 'Not for these files' : (tool ? tool.label : 'Coming soon');
      q('.hub-hint').textContent = dim ? 'Pick a lit slot' : (tool ? (tool.hint || cat.hint || '') : (cat ? 'These tools are not installed yet.' : ''));
      const pips = q('.hub-pips');
      pips.innerHTML = list.length > 1 ? list.map((t, k) => `<i class="${k === this.toolIdx[cat.id] ? 'on' : ''}"></i>`).join('') : '';
      q('.hub-cycle').style.visibility = list.length > 1 && !dim ? 'visible' : 'hidden';
      if (animate) {
        this.hub.classList.remove('tick', 'tick-l', 'tick-r');
        void this.hub.offsetWidth;
        this.hub.classList.add(dir > 0 ? 'tick-r' : dir < 0 ? 'tick-l' : 'tick');
      }
      this.host.setAttribute('aria-activedescendant', '');
      if (this.opts.onChange) this.opts.onChange({ index: this.index, category: cat, tool });
    }
  }

  window.Wheel = Wheel;
})();
