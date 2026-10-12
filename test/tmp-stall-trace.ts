// TEMPORARY: removed before this PR is ready. Enabled by LOBSTAH_STALL_TRACE
// (a directory). Says where a slow test spends its time:
//  - a watchdog thread notices the main thread blocked (a synchronous wait or
//    spin) and records the main thread's stack through the inspector;
//  - a sampler lists the child processes a slow test is waiting on.
import { afterEach, beforeEach, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve(process.env.LOBSTAH_STALL_TRACE!);
const SLOW_MS = Number(process.env.LOBSTAH_STALL_SLOW_MS ?? 8000);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${process.pid}.log`);
const t0 = Date.now();
const stamp = () => new Date().toISOString();
const log = (line: string) => fs.appendFileSync(file, `${stamp()} ${line}\n`);

const shared = new Int32Array(new SharedArrayBuffer(4));
const beat = setInterval(() => Atomics.store(shared, 0, Date.now() - t0), 200);
beat.unref();

const watchdog = new Worker(
  `
const { workerData } = require('node:worker_threads');
const inspector = require('node:inspector');
const fs = require('node:fs');
const { shared, t0, file } = workerData;
const log = (line) => fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\\n');
let session;
let pausing = false;
let reported = -Infinity;
setInterval(() => {
  const now = Date.now() - t0;
  const blocked = now - Atomics.load(shared, 0);
  if (blocked < 3000 || now - reported < 3000 || pausing) return;
  reported = now;
  log('[watchdog] main thread blocked for ' + blocked + 'ms');
  try {
    if (!session) {
      session = new inspector.Session();
      session.connectToMainThread();
      session.on('Debugger.paused', (m) => {
        const frames = m.params.callFrames.slice(0, 30).map((f) => '    at ' + (f.functionName || '(anonymous)') + ' (' + f.url + ':' + (f.location.lineNumber + 1) + ')').join('\\n');
        log('[watchdog] main thread stack (blocked ' + (Date.now() - t0 - Atomics.load(shared, 0)) + 'ms):\\n' + frames);
        session.post('Debugger.resume');
        pausing = false;
      });
      session.post('Debugger.enable');
    }
    pausing = true;
    session.post('Debugger.pause');
  } catch (err) {
    log('[watchdog] inspector failed: ' + err);
  }
}, 500);
`,
  { eval: true, workerData: { shared, t0, file } },
);
watchdog.unref();

interface Handle { spawnargs?: string[]; pid?: number; constructor: { name: string } }
let name = '';
let started = 0;
let sampler: NodeJS.Timeout | undefined;
const children = () =>
  (process as unknown as { _getActiveHandles(): Handle[] })
    ._getActiveHandles()
    .filter((h) => Array.isArray(h.spawnargs))
    .map((h) => `pid ${h.pid}: ${h.spawnargs!.join(' ').slice(0, 300)}`);

beforeEach(() => {
  name = expect.getState().currentTestName ?? '?';
  started = Date.now();
  let last = Date.now();
  sampler = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 1000;
    last = now;
    const ran = now - started;
    if (drift > 2000) log(`[sampler] ${name}: timer late by ${drift}ms at ${ran}ms`);
    if (ran > SLOW_MS) log(`[sampler] ${name}: running ${ran}ms; children: ${JSON.stringify(children())}`);
  }, 1000);
  sampler.unref();
});
afterEach(() => {
  clearInterval(sampler);
  const ran = Date.now() - started;
  if (ran > SLOW_MS) log(`[sampler] ${name}: finished or timed out after ${ran}ms`);
});
