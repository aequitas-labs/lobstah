// TEMPORARY: removed before this PR is ready. Measures, on the CI runner, what
// keeps a directory from being removed after the process standing in it is
// killed, and which "it is gone" signal is safe to remove on.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const N = Number(process.argv[2] ?? 60);
const IDLE = 'console.log("up"); setInterval(() => {}, 1000)';

async function standIn(dir) {
  const child = spawn(process.execPath, ['-e', IDLE], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  return child;
}
const exited = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)));
const pidGone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (err) { return err.code !== 'EPERM'; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Remove now; on failure, keep trying and report how long the directory stayed held. */
async function removeTimed(dir) {
  const t0 = process.hrtime.bigint();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: undefined, heldMs: 0 };
  } catch (err) {
    for (;;) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return { code: err.code, heldMs: Number(process.hrtime.bigint() - t0) / 1e6 };
      } catch {
        if (Number(process.hrtime.bigint() - t0) / 1e6 > 20_000) return { code: err.code, heldMs: Infinity };
        await sleep(1);
      }
    }
  }
}

const variants = {
  // What soak-listener's afterEach did: kill, then remove at once.
  'kill, remove at once': async (child) => { child.kill('SIGKILL'); },
  // Kill, then wait for Node's exit event.
  'kill, await exit event': async (child) => { child.kill('SIGKILL'); await exited(child); },
  // What `soak stop-listener` reports on: SIGTERM, then poll kill(pid, 0).
  'SIGTERM, poll kill(pid,0)': async (child) => {
    process.kill(child.pid, 'SIGTERM');
    while (!pidGone(child.pid)) await sleep(1);
  },
  // Control: nobody stands in the directory.
  'no process in it': async (child) => { child.kill('SIGKILL'); await exited(child); await sleep(50); },
};

const summary = {};
for (const [name, stop] of Object.entries(variants)) {
  const failures = [];
  for (let i = 0; i < N; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-probe-'));
    const child = await standIn(dir);
    await stop(child);
    const res = await removeTimed(dir);
    if (res.code) failures.push(res);
    if (child.exitCode === null && child.signalCode === null) await exited(child);
  }
  const held = failures.map((f) => f.heldMs).sort((a, b) => a - b);
  summary[name] = {
    runs: N,
    failed: failures.length,
    codes: [...new Set(failures.map((f) => f.code))].join(',') || '-',
    heldMsMedian: held.length ? held[Math.floor(held.length / 2)].toFixed(1) : '-',
    heldMsMax: held.length ? held[held.length - 1].toFixed(1) : '-',
  };
}
console.log(`platform: ${process.platform}, node ${process.version}`);
console.table(summary);
