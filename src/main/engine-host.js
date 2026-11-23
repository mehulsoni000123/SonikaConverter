'use strict';
// Runs the conversion engine in an Electron utility process so heavy work never freezes the interface.
// Talks to the main process through process.parentPort messages:
//   in : { type:'describe' } | { type:'run', jobId, toolId, inputs, options, outDir, settings } | { type:'cancel', jobId }
//   out: { type:'describe', categories, tools, loadErrors } | { type:'progress', jobId, fraction, text }
//        { type:'done', jobId, result } | { type:'error', jobId, message, cancelled }
const path = require('path');

const engine = require(path.join(__dirname, '..', 'engine', 'index.js'));

// Test hook: the scenario test can add fake tools at runtime (never used in normal runs).
if (process.env.SONIKA_INJECT_TOOLS) {
  try {
    const mod = require(process.env.SONIKA_INJECT_TOOLS);
    for (const t of (mod.fakeTools || [])) engine.tools.push(t);
  } catch (err) {
    engine.loadErrors.push({ module: 'test-inject', error: err.message });
  }
}

const running = new Map(); // jobId -> AbortController
const port = process.parentPort;

function send(msg) { port.postMessage(msg); }

function cleanMessage(err) {
  const raw = (err && err.message) ? String(err.message) : String(err || 'Something went wrong.');
  // First line only; never a stack trace.
  return raw.split(/\r?\n/)[0].trim() || 'Something went wrong.';
}

async function runJob(msg) {
  const { jobId, toolId, inputs, options, outDir, settings } = msg;
  const tool = engine.getTool(toolId);
  if (!tool) {
    send({ type: 'error', jobId, message: 'This converter is not available right now.', cancelled: false });
    return;
  }
  const controller = new AbortController();
  running.set(jobId, controller);
  let lastSent = 0;
  const ctx = {
    signal: controller.signal,
    outDir: outDir || null,
    settings: settings || {},
    onProgress(fraction, text) {
      const now = Date.now();
      const f = Math.max(0, Math.min(1, Number(fraction) || 0));
      // Throttle to ~20 updates a second; always send completion.
      if (now - lastSent < 50 && f < 1) return;
      lastSent = now;
      send({ type: 'progress', jobId, fraction: f, text: text ? String(text) : '' });
    },
  };
  try {
    const result = await tool.run(inputs, { ...engine.defaultOptions(tool), ...(options || {}) }, ctx);
    if (controller.signal.aborted) throw new Error('Cancelled');
    const r = result || {};
    send({
      type: 'done',
      jobId,
      result: {
        outputs: Array.isArray(r.outputs) ? r.outputs.map(String) : [],
        message: r.message ? String(r.message) : '',
        text: typeof r.text === 'string' ? r.text : null,
      },
    });
  } catch (err) {
    const cancelled = controller.signal.aborted || /^cancel/i.test(cleanMessage(err));
    send({ type: 'error', jobId, message: cancelled ? 'Cancelled' : cleanMessage(err), cancelled });
  } finally {
    running.delete(jobId);
  }
}

port.on('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'describe') {
    send({ type: 'describe', categories: engine.categories, tools: engine.describeTools(), loadErrors: engine.loadErrors });
  } else if (msg.type === 'run') {
    runJob(msg);
  } else if (msg.type === 'cancel') {
    const c = running.get(msg.jobId);
    if (c) c.abort();
  }
});

process.on('uncaughtException', (err) => {
  // Keep the host alive; a single bad callback must not take down the other jobs.
  console.error('[engine-host] uncaught:', cleanMessage(err));
});
process.on('unhandledRejection', () => { /* each job awaits its own promise */ });

send({ type: 'ready' });
