'use strict';
// Word / Excel / PowerPoint -> PDF through the Microsoft Office programs installed on this PC (COM automation).
const path = require('path');
const util = require('./util');
const du = require('./scripts/docutil');
const { runOffice } = require('./scripts/office-runner');

function timeoutFor(ctx, fallback) {
  const s = ctx && ctx.settings && Number(ctx.settings.officeTimeoutSec);
  return s > 0 ? s : fallback;
}

const wordToPdf = {
  id: 'word-to-pdf',
  category: 'word',
  label: 'Word to PDF',
  hint: 'Turn a Word document into a PDF',
  accepts: ['.docx', '.doc', '.rtf', '.odt', '.txt'],
  multi: 'each',
  isDefault: true,
  options: [],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const outDir = util.resolveOutDir(inputs, ctx);
    ctx.onProgress(0.02, 'Getting ready');
    const r = await runOffice({
      app: 'word', action: 'pdf', destExt: '.pdf', source: input, outDir,
      baseName: du.baseNameNoExt(input), timeoutSec: timeoutFor(ctx, 120), signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
    ctx.onProgress(1, 'Done');
    return { outputs: [r.outputPath], message: `Made ${path.basename(r.outputPath)} in ${r.seconds.toFixed(1)} s using Microsoft Word.` };
  },
};

const officeToPdf = {
  id: 'office-to-pdf',
  category: 'word',
  label: 'Excel / PowerPoint to PDF',
  hint: 'Turn a spreadsheet or slide deck into a PDF',
  accepts: ['.xlsx', '.xls', '.pptx', '.ppt'],
  multi: 'each',
  options: [
    { key: 'fitWidth', label: 'Fit spreadsheet width to one page', type: 'toggle', default: true },
  ],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const ext = path.extname(input).toLowerCase();
    const app = (ext === '.xlsx' || ext === '.xls') ? 'excel' : 'powerpoint';
    const outDir = util.resolveOutDir(inputs, ctx);
    ctx.onProgress(0.02, 'Getting ready');
    const r = await runOffice({
      app, action: 'pdf', destExt: '.pdf', source: input, outDir,
      baseName: du.baseNameNoExt(input), timeoutSec: timeoutFor(ctx, 120), signal: ctx.signal,
      onProgress: ctx.onProgress, fitWidth: !options || options.fitWidth !== false,
    });
    ctx.onProgress(1, 'Done');
    const appName = app === 'excel' ? 'Microsoft Excel' : 'Microsoft PowerPoint';
    return { outputs: [r.outputPath], message: `Made ${path.basename(r.outputPath)} in ${r.seconds.toFixed(1)} s using ${appName}.` };
  },
};

module.exports = { tools: [wordToPdf, officeToPdf] };
