'use strict';
// Job queue: runs at most `concurrency` jobs at once, keeps a short session history,
// and reports batch completion so the app can notify when a whole batch is finished.
const path = require('path');
const { EventEmitter } = require('events');

const HISTORY_LIMIT = 60;

/** Turn any engine error into one short plain-English sentence. */
function plainError(message) {
  let m = String(message || '').split(/\r?\n/)[0].trim();
  if (!m) return 'Something went wrong. Please try again.';
  const proc = m.match(/^([\w.-]+)\.exe failed \(code -?\d+\):\s*(.*)$/i);
  if (proc) {
    const name = proc[1].toLowerCase() === 'ffmpeg' ? 'FFmpeg' : proc[1];
    const detail = proc[2] ? ' Details: ' + proc[2] : '';
    m = `${name} could not convert this file.${detail}`;
  }
  m = m.replace(/^Error:\s*/i, '');
  if (m.length > 260) m = m.slice(0, 257).trimEnd() + '...';
  return m;
}

class JobQueue extends EventEmitter {
  /** runner(job, onProgress) -> { promise, cancel } */
  constructor({ runner, concurrency }) {
    super();
    this.runner = runner;
    this.concurrency = Math.max(1, Math.min(4, concurrency || 2));
    this.jobs = [];           // newest last
    this.active = new Map();  // jobId -> handle
    this.seq = 0;
    this.batchSeq = 0;
  }

  newBatchId() { this.batchSeq += 1; return `b${Date.now().toString(36)}${this.batchSeq}`; }

  /** spec = { tool:{id,label,category,multi}, inputs:[...], options, outDir, settings, batchId, source } */
  add(spec) {
    this.seq += 1;
    const job = {
      id: `j${Date.now().toString(36)}${this.seq}`,
      batchId: spec.batchId,
      source: spec.source || 'app',
      toolId: spec.tool.id,
      toolLabel: spec.tool.label,
      category: spec.tool.category,
      inputs: spec.inputs.slice(),
      title: spec.inputs.length === 1 ? path.basename(spec.inputs[0]) : `${spec.inputs.length} files`,
      options: { ...(spec.options || {}) },
      outDir: spec.outDir || null,
      settings: spec.settings || {},
      status: 'queued',
      progress: 0,
      statusText: 'Waiting...',
      outputs: [],
      message: '',
      text: null,
      error: '',
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
    };
    this.jobs.push(job);
    this.trim();
    this.emit('update', job);
    this.pump();
    return job;
  }

  trim() {
    while (this.jobs.length > HISTORY_LIMIT) {
      const idx = this.jobs.findIndex((j) => j.status !== 'queued' && j.status !== 'running');
      if (idx < 0) break;
      this.jobs.splice(idx, 1);
    }
  }

  get(id) { return this.jobs.find((j) => j.id === id) || null; }

  list() { return this.jobs.map(publicJob); }

  pump() {
    while (this.active.size < this.concurrency) {
      const next = this.jobs.find((j) => j.status === 'queued');
      if (!next) return;
      this.start(next);
    }
  }

  start(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    job.statusText = 'Starting...';
    this.emit('update', job);
    const handle = this.runner(job, (fraction, text) => {
      if (job.status !== 'running') return;
      job.progress = Math.max(job.progress, Math.max(0, Math.min(1, fraction || 0)));
      if (text) job.statusText = text;
      this.emit('update', job);
    });
    this.active.set(job.id, handle);
    handle.promise.then((result) => {
      // A job that finished just as Cancel was pressed still counts as done: its files exist.
      if (job.status !== 'running' && job.status !== 'cancelling') return;
      job.status = 'done';
      job.progress = 1;
      job.outputs = (result && result.outputs) || [];
      job.message = (result && result.message) || '';
      job.text = (result && typeof result.text === 'string') ? result.text : null;
      job.statusText = job.message || 'Done';
    }).catch((err) => {
      if (job.status !== 'running' && job.status !== 'cancelling') return;
      if (job.status === 'cancelling' || (err && err.cancelled)) {
        job.status = 'cancelled';
        job.statusText = 'Cancelled';
      } else {
        job.status = 'error';
        job.error = plainError(err && err.message);
        job.statusText = job.error;
      }
    }).finally(() => {
      job.finishedAt = Date.now();
      this.active.delete(job.id);
      this.emit('update', job);
      this.checkBatch(job.batchId);
      this.pump();
    });
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.statusText = 'Cancelled';
      job.finishedAt = Date.now();
      this.emit('update', job);
      this.checkBatch(job.batchId);
      return true;
    }
    if (job.status === 'running') {
      job.status = 'cancelling';
      job.statusText = 'Cancelling...';
      this.emit('update', job);
      const h = this.active.get(id);
      if (h) h.cancel();
      return true;
    }
    return false;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'cancelling');
    this.emit('cleared');
  }

  checkBatch(batchId) {
    const batch = this.jobs.filter((j) => j.batchId === batchId);
    if (batch.length && batch.every((j) => ['done', 'error', 'cancelled'].includes(j.status))) {
      this.emit('batch-done', batchId, batch.map(publicJob));
    }
  }
}

function publicJob(j) {
  return {
    id: j.id, batchId: j.batchId, source: j.source, toolId: j.toolId, toolLabel: j.toolLabel, category: j.category,
    title: j.title, inputs: j.inputs, options: j.options, status: j.status, progress: j.progress, statusText: j.statusText,
    outputs: j.outputs, message: j.message, text: j.text, error: j.error,
    createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  };
}

module.exports = { JobQueue, publicJob, plainError };
