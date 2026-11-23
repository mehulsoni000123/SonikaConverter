'use strict';
// Tool registry. Each module exports { tools: [ ...tool objects... ] }. See CONTRACT in each agent brief:
//   tool = { id, category, label, hint, accepts: ['.ext'], multi: 'each'|'combine', isDefault?: true,
//            options: [{ key, label, type: 'choice'|'number'|'text'|'toggle', choices?: [{value,label}], default }],
//            async run(inputs, options, ctx) -> { outputs: [absPath], message } }
//   ctx  = { onProgress(fraction0to1, text), signal, outDir (string|null), settings }
const path = require('path');

// Wheel slots, clockwise from the top.
const categories = [
  { id: 'audio', label: 'AUDIO', hint: 'Pull audio out of any video' },
  { id: 'transcript', label: 'TRANSCRIPT', hint: 'Speech to text with Handy' },
  { id: 'pdf', label: 'PDF', hint: 'Merge, split, compress, convert' },
  { id: 'word', label: 'WORD', hint: 'Word and Office to PDF' },
  { id: 'video', label: 'VIDEO', hint: 'Compress, convert, trim, GIF' },
  { id: 'image', label: 'IMAGE', hint: 'Convert, resize, compress' },
];

const moduleNames = ['media', 'transcribe', 'pdf', 'office', 'image'];
const tools = [];
const loadErrors = [];

for (const name of moduleNames) {
  try {
    const mod = require('./' + name);
    for (const tool of (mod.tools || [])) tools.push(tool);
  } catch (err) {
    loadErrors.push({ module: name, error: err.message });
  }
}

function getTool(id) {
  return tools.find((t) => t.id === id) || null;
}

function toolsForCategory(categoryId) {
  return tools.filter((t) => t.category === categoryId);
}

/** Tools that accept this file (by extension, case-insensitive). */
function toolsForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return tools.filter((t) => t.accepts.includes(ext));
}

/** Option defaults for a tool, as a plain object. */
function defaultOptions(tool) {
  const out = {};
  for (const opt of (tool.options || [])) out[opt.key] = opt.default;
  return out;
}

/** Plain-data description of every tool (no functions) - safe to send to the renderer. */
function describeTools() {
  return tools.map((t) => ({
    id: t.id, category: t.category, label: t.label, hint: t.hint,
    accepts: t.accepts, multi: t.multi, isDefault: !!t.isDefault, options: t.options || [],
  }));
}

module.exports = { categories, tools, loadErrors, getTool, toolsForCategory, toolsForFile, defaultOptions, describeTools };
