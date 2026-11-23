'use strict';
// Main-process side of the engine utility process. Restarts the host if it ever dies and
// fails the jobs that were running with a plain-English message.
const path = require('path');
const { utilityProcess } = require('electron');
const { EventEmitter } = require('events');

class EngineClient extends EventEmitter {
  constructor(env) {
    super();
    this.env = env || {};
    this.child = null;
    this.jobs = new Map(); // jobId -> { resolve, reject, onProgress }
    this.registry = { categories: [], tools: [], loadErrors: [] };
    this.describeWaiters = [];
    this.stopping = false;
  }

  start() {
    this.child = utilityProcess.fork(path.join(__dirname, 'engine-host.js'), [], {
      serviceName: 'Sonika Converter engine',
      env: { ...process.env, ...this.env },
      stdio: 'pipe',
    });
    if (this.child.stdout) this.child.stdout.on('data', (d) => process.stdout.write('[engine] ' + d));
    if (this.child.stderr) this.child.stderr.on('data', (d) => process.stderr.write('[engine] ' + d));
    this.child.on('message', (msg) => this.onMessage(msg));
    this.child.on('exit', () => {
      this.child = null;
      for (const [, j] of this.jobs) j.reject(new Error('The converter stopped unexpectedly. Please try again.'));
      this.jobs.clear();
      if (!this.stopping) setTimeout(() => { this.start(); this.describe(); }, 300);
    });
    return this.describe();
  }

  stop() {
    this.stopping = true;
    if (this.child) { try { this.child.kill(); } catch (_) { /* gone */ } }
  }

  describe() {
    return new Promise((resolve) => {
      this.describeWaiters.push(resolve);
      if (this.child) this.child.postMessage({ type: 'describe' });
    });
  }

  onMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'describe') {
      this.registry = { categories: msg.categories || [], tools: msg.tools || [], loadErrors: msg.loadErrors || [] };
      const waiters = this.describeWaiters.splice(0);
      for (const w of waiters) w(this.registry);
      this.emit('registry', this.registry);
      return;
    }
    const job = this.jobs.get(msg.jobId);
    if (!job) return;
    if (msg.type === 'progress') job.onProgress(msg.fraction, msg.text);
    else if (msg.type === 'done') { this.jobs.delete(msg.jobId); job.resolve(msg.result); }
    else if (msg.type === 'error') {
      this.jobs.delete(msg.jobId);
      const err = new Error(msg.message || 'Something went wrong.');
      err.cancelled = !!msg.cancelled;
      job.reject(err);
    }
  }

  /** Run one job. Returns { promise, cancel }. */
  run(spec, onProgress) {
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('The converter is starting. Please try again in a moment.')); return; }
      this.jobs.set(spec.jobId, { resolve, reject, onProgress: onProgress || (() => {}) });
      this.child.postMessage({ type: 'run', ...spec });
      cancel = () => { if (this.child) this.child.postMessage({ type: 'cancel', jobId: spec.jobId }); };
    });
    return { promise, cancel: () => cancel() };
  }
}

module.exports = { EngineClient };
