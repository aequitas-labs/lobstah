import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { addWatch, readWatch, readWatchEvents, removeWatch, runWatchCheck } from '../src/watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-watch-race-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('concurrent writers of the same watch all complete with a valid record', async () => {
  const moduleUrl = new URL('../dist/watch.js', import.meta.url).href;
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from(
    { length: 4 },
    () =>
      new Worker(
        `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.moduleUrl).then(({ addWatch }) => {
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      for (let n = 0; n < 100; n++) addWatch('pr:org/repo#2135', 'echo ' + n);
    });
  `,
        { eval: true, workerData: { moduleUrl, gate }, env: { ...process.env, LOBSTAH_HOME: home } },
      ),
  );
  const finished = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
      }),
  );
  // Observe rejections immediately, even while the other workers are starting.
  const result = Promise.allSettled(finished);
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve) => worker.once('message', () => resolve()))));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    expect(await result).toEqual(Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: undefined })));
    expect(readWatch('pr:org/repo#2135')?.check).toBe('echo 99');
    expect(fs.readdirSync(path.join(home, 'watches')).filter((name) => name.includes('.tmp'))).toEqual([]);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it('a check finishing after retirement does not resurrect its watch or deliver stale events', () => {
  const script = path.join(home, 'retire.cjs');
  fs.writeFileSync(
    script,
    `
    require('node:fs').unlinkSync(${JSON.stringify(path.join(home, 'watches', 'retired.json'))});
    console.log(JSON.stringify({ cursor: '1', events: [{ seq: 1, summary: 'stale' }] }));
  `,
  );
  const watch = addWatch('retired', `"${process.execPath}" "${script}"`);
  expect(runWatchCheck(watch).fresh).toEqual([]);
  expect(readWatch('retired')).toBeUndefined();
  expect(readWatchEvents('retired')).toEqual([]);
});

it('a listed watch retired before its check is a quiet no-op', () => {
  const watch = addWatch('retired', 'this command must never run');
  removeWatch(watch.key);
  expect(runWatchCheck(watch).fresh).toEqual([]);
  expect(readWatch(watch.key)).toBeUndefined();
});
