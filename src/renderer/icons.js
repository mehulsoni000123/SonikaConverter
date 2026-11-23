'use strict';
// Original line icons (24 x 24 grid, 1.75 stroke, round joins). Inline SVG only; no icon fonts, no emoji.
(function () {
  const P = {
    // ---- wheel categories ----
    audio: '<path d="M3.5 10.5v3M7 7.5v9M10.5 4.5v15M14 8v8M17.5 6v12M21 10.5v3"/>',
    transcript: '<path d="M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7.5L7 20.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/><path d="M7.5 9h9M7.5 12.5h6"/>',
    pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><rect x="3" y="12.5" width="11" height="5.5" rx="1.4"/><path d="M5.6 16.6v-2.7h1.2a.9.9 0 0 1 0 1.8H5.6"/>',
    word: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 12.5h7M8.5 16h7M8.5 9h3"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.6-2.8z"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M3.5 17l5-5 4 4 2.5-2.5 5.5 5"/>',

    // ---- tools ----
    'video-to-audio': '<rect x="2.5" y="6" width="10" height="9" rx="2"/><path d="M6.4 8.7v3.6l3-1.8z"/><path d="M14.5 10.5h3"/><path d="M16.3 8.7l1.8 1.8-1.8 1.8"/><path d="M20.5 7v7"/><path d="M20.5 14a1.5 1.5 0 1 1-1.5-1.5h1.5"/><path d="M4 19h16"/>',
    transcribe: '<path d="M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7.5L7 20.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/><path d="M7 10.5v1M9.5 9v4M12 8v6M14.5 9.5v3M17 10.5v1"/>',
    'pdf-merge': '<rect x="3" y="3.5" width="9" height="12" rx="1.6"/><rect x="12" y="8.5" width="9" height="12" rx="1.6"/><path d="M7.5 18.5v-1M16.5 5.5v1"/><path d="M14.5 13h4M16.5 11v4"/>',
    'pdf-split': '<path d="M6 3h8l4 4v4"/><path d="M6 3a1.5 1.5 0 0 0-1.5 1.5V11"/><path d="M3 13.5h18" stroke-dasharray="2 2.2"/><path d="M4.5 16v3.5A1.5 1.5 0 0 0 6 21h10.5a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    'pdf-compress': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 9.5v3.5M10.3 11.4l1.7 1.7 1.7-1.7M12 19v-3M10.3 17.6l1.7-1.6 1.7 1.6"/>',
    'pdf-to-word': '<rect x="2.5" y="4" width="8" height="11" rx="1.5"/><path d="M4.8 8h3.4M4.8 11h2.4"/><path d="M12 9.5h3"/><path d="M13.8 7.8l1.7 1.7-1.7 1.7"/><rect x="16" y="4" width="5.5" height="16" rx="1.5"/><path d="M17.8 8h2M17.8 11h2M17.8 14h2"/>',
    'pdf-to-jpg': '<rect x="2.5" y="3.5" width="8" height="11" rx="1.5"/><path d="M4.8 7.5h3.4M4.8 10.5h2.4"/><path d="M12 9h3"/><path d="M13.8 7.3l1.7 1.7-1.7 1.7"/><rect x="11.5" y="12" width="10" height="8.5" rx="1.6"/><path d="M12 19l3-3 2.3 2.3 1.4-1.4 2.6 2.6"/>',
    'images-to-pdf': '<rect x="2.5" y="6.5" width="9" height="7.5" rx="1.4"/><rect x="4.5" y="4" width="9" height="7.5" rx="1.4"/><path d="M15 11h2.5"/><path d="M16.3 9.3l1.7 1.7-1.7 1.7"/><path d="M19.5 6.5h-0.5"/><rect x="18.5" y="5" width="3" height="12" rx="1"/><path d="M3 18.5h12"/>',
    'word-to-pdf': '<rect x="2.5" y="3.5" width="8.5" height="12" rx="1.5"/><path d="M4.8 7.5h4M4.8 10.5h4M4.8 13h2.5"/><path d="M12.5 9.5h3"/><path d="M14.3 7.8l1.7 1.7-1.7 1.7"/><path d="M18 8.5h-1a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h3.5a1 1 0 0 0 1-1V11.5z"/><path d="M17.5 17.5h2.5"/>',
    'office-to-pdf': '<rect x="2.5" y="4" width="6" height="7" rx="1.2"/><rect x="2.5" y="13" width="6" height="7" rx="1.2"/><path d="M4.3 6.8h2.4M4.3 15.8l2.4 2.4M6.7 15.8l-2.4 2.4"/><path d="M10.5 12h3"/><path d="M12.3 10.3l1.7 1.7-1.7 1.7"/><path d="M18 5h-1.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V8.5z"/><path d="M17 16.5h3"/>',
    'video-compress': '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 9l3 3-3 3M17 9l-3 3 3 3"/>',
    'video-to-mp4': '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M15.5 10.2a4 4 0 0 0-7-.2"/><path d="M8.5 7.6V10h2.4"/><path d="M8.5 13.8a4 4 0 0 0 7 .2"/><path d="M15.5 16.4V14h-2.4"/>',
    'video-trim': '<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.4L20 17M8.6 15.6L20 7"/>',
    'video-to-gif': '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M8 12a4 4 0 0 1 7.2-2.4"/><path d="M15.6 7.4v2.5h-2.5"/><path d="M16 12a4 4 0 0 1-7.2 2.4"/><path d="M8.4 16.6v-2.5h2.5"/>',
    'image-convert': '<rect x="3" y="4.5" width="13" height="11" rx="2"/><path d="M3.5 13.5l3.5-3.5 3 3 2-2 3.5 3.5"/><path d="M20.5 11v3.5a5 5 0 0 1-5 5H12"/><path d="M14 17.5l-2 2 2 2"/>',
    'image-resize': '<path d="M3.5 9V5a1.5 1.5 0 0 1 1.5-1.5h4M15 3.5h4A1.5 1.5 0 0 1 20.5 5v4M20.5 15v4a1.5 1.5 0 0 1-1.5 1.5h-4M9 20.5H5A1.5 1.5 0 0 1 3.5 19v-4"/><path d="M9 15l6-6M11 9h4v4"/>',
    'image-compress': '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M8 8.5l2.5 2.5M10.5 8.5V11H8M16 15.5L13.5 13M13.5 15.5V13H16"/>',

    // ---- interface ----
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    open: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    up: '<path d="M12 18V6M6.5 11.5L12 6l5.5 5.5"/>',
    down: '<path d="M12 6v12M6.5 12.5L12 18l5.5-5.5"/>',
    left: '<path d="M14.5 6l-6 6 6 6"/>',
    right: '<path d="M9.5 6l6 6-6 6"/>',
    drop: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
    bolt: '<path d="M13 3L5 13.5h6L10.5 21 19 10h-6z"/>',
    trash: '<path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12M9.5 7V4.5h5V7"/>',
  };

  function svg(name, size, extraClass) {
    const body = P[name] || P.file;
    const s = size || 20;
    return `<svg class="ico${extraClass ? ' ' + extraClass : ''}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  /** Icon for a tool: its own drawing when there is one, otherwise its category's. */
  function forTool(tool, size, extraClass) {
    if (tool && P[tool.id]) return svg(tool.id, size, extraClass);
    return svg(tool ? tool.category : 'file', size, extraClass);
  }

  function raw(name) { return P[name] || P.file; }

  window.Icons = { svg, forTool, raw, has: (n) => !!P[n] };
})();
