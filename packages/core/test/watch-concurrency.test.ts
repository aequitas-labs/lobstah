import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
  vi.restoreAllMocks();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient %s on watch lock creation and removal', (code) => {
  const lock = path.join(home, 'watches', 'retry.json.lock');
  const mkdir = fs.mkdirSync;
  const rmdir = fs.rmdirSync;
  let creates = 0,
    removes = 0;
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof mkdir>) => {
    if (args[0] === lock && ++creates <= 2) throw Object.assign(new Error(`transient ${code}`), { code });
    return mkdir(...args);
  }) as typeof mkdir);
  vi.spyOn(fs, 'rmdirSync').mockImplementation(((...args: Parameters<typeof rmdir>) => {
    if (args[0] === lock && ++removes <= 2) throw Object.assign(new Error(`transient ${code}`), { code });
    return rmdir(...args);
  }) as typeof rmdir);
  expect(addWatch('retry', 'echo ok').check).toBe('echo ok');
  expect(creates).toBe(3);
  expect(removes).toBe(3);
  expect(readWatch('retry')?.check).toBe('echo ok');
  expect(fs.existsSync(lock)).toBe(false);
});

it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient %s while publishing a watch', (code) => {
  const file = path.join(home, 'watches', 'rename.json');
  addWatch('rename', 'echo old');
  const rename = fs.renameSync;
  let attempts = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (target === file && ++attempts <= 2) throw Object.assign(new Error(`transient ${code}`), { code });
    return rename(source, target);
  });
  expect(addWatch('rename', 'echo new').check).toBe('echo new');
  expect(attempts).toBe(3);
  expect(readWatch('rename')?.check).toBe('echo new');
  expect(fs.readdirSync(path.dirname(file))).toEqual(['rename.json']);
});

it('persistent rename contention fails at the existing watch-lock deadline, preserving the last record', () => {
  addWatch('rename', 'echo old');
  const rename = fs.renameSync;
  const denied = Object.assign(new Error('rename denied'), { code: 'EPERM' });
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (target === path.join(home, 'watches', 'rename.json')) throw denied;
    return rename(source, target);
  });
  expect(() => addWatch('rename', 'echo new')).toThrow(denied);
  expect(now).toBeGreaterThanOrEqual(11_000);
  expect(now).toBeLessThanOrEqual(12_000);
  expect(readWatch('rename')?.check).toBe('echo old');
  expect(fs.readdirSync(path.join(home, 'watches'))).toEqual(['rename.json']);
});

it.each(['mkdirSync', 'rmdirSync'] as const)('a persistent permission error on %s fails at the bounded deadline', (operation) => {
  const lock = path.join(home, 'watches', 'denied.json.lock');
  const original = fs[operation];
  const denied = Object.assign(new Error(`permission denied: ${lock}`), { code: 'EACCES' });
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
  vi.spyOn(fs, operation).mockImplementation(((...args: Parameters<typeof original>) => {
    if (args[0] === lock) throw denied;
    return original(...args);
  }) as typeof original);
  expect(() => addWatch('denied', 'echo ok')).toThrow(denied);
  expect(now).toBeGreaterThanOrEqual(11_000);
  expect(now).toBeLessThanOrEqual(12_000);
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
