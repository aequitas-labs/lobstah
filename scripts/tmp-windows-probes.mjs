// TEMPORARY: removed before this PR is ready. Measures, on the CI runner, what
// keeps a directory from being removed after the process standing in it is
// killed, and which "it is gone" signal is safe to remove on.
import { spawn, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mode = process.argv[2] ?? 'ebusy';
const N = Number(process.argv[3] ?? 60);
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

async function ebusy(N) {
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
}

const stats = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : '-');
  return { n: s.length, min: q(0), median: q(0.5), p90: q(0.9), max: s.length ? Math.round(s[s.length - 1]) : '-' };
};
const timed = (file, args, timeout = 120_000) => {
  const t = process.hrtime.bigint();
  const res = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, ok: res.status === 0, err: res.error?.code, lines: (res.stdout ?? '').split(/\r?\n/).filter(Boolean).length };
};

/** How long the process listing's PowerShell takes: host start alone, and with the snapshot. */
async function powershell(N, label) {
  if (process.platform !== 'win32') return console.log('powershell: not Windows');
  const { WINDOWS_PROCESS_SNAPSHOT } = await import('../packages/runner/dist/windows-processes.js');
  const base = ['-NoProfile', '-NonInteractive', '-Command'];
  const kinds = {
    'powershell exit': () => timed('powershell.exe', [...base, 'exit']),
    'powershell snapshot (listProcesses)': () => timed('powershell.exe', [...base, WINDOWS_PROCESS_SNAPSHOT]),
    'pwsh exit': () => timed('pwsh.exe', [...base, 'exit']),
    'pwsh Get-Process parent': () => timed('pwsh.exe', [...base, 'Get-Process | ForEach-Object { "$($_.Id) $($_.Parent.Id)" }']),
    'node -e 0 (control)': () => timed(process.execPath, ['-e', '0']),
  };
  const first = {};
  const all = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
  const failed = Object.fromEntries(Object.keys(kinds).map((k) => [k, 0]));
  for (let i = 0; i < N; i++) {
    for (const [k, run] of Object.entries(kinds)) {
      const r = run();
      if (i === 0) first[k] = `${Math.round(r.ms)}ms${r.ok ? '' : ` FAILED ${r.err ?? ''}`} (${r.lines} lines)`;
      else all[k].push(r.ms);
      if (!r.ok) failed[k]++;
      if (r.ms > 10_000) console.log(`${new Date().toISOString()} SLOW ${label} ${k}: ${Math.round(r.ms)}ms ok=${r.ok} ${r.err ?? ''}`);
    }
  }
  console.log(`powershell timings (${label}); first call:`, first);
  console.table(Object.fromEntries(Object.entries(all).map(([k, ms]) => [k, { ...stats(ms), failed: failed[k] }])));
}

/** Sample the snapshot every few seconds until `stopFile` appears: latency under whatever else runs. */
async function powershellWatch(stopFile, label) {
  if (process.platform !== 'win32') return;
  const { WINDOWS_PROCESS_SNAPSHOT } = await import('../packages/runner/dist/windows-processes.js');
  const ms = [];
  while (!fs.existsSync(stopFile)) {
    const r = timed('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SNAPSHOT]);
    ms.push(r.ms);
    console.log(`${new Date().toISOString()} snapshot ${label}: ${Math.round(r.ms)}ms ok=${r.ok} ${r.err ?? ''}`);
    await sleep(3000);
  }
  console.log(`snapshot under load (${label}):`, stats(ms));
}

const cli = fileURLToPath(new URL('../apps/cli/dist/main.js', import.meta.url));
const freePort = () =>
  new Promise((resolve, reject) => {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const server = net.createServer();
    server.once('error', () => freePort().then(resolve, reject));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(port)));
  });
const version = (port) =>
  new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/version`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(undefined); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });

/**
 * Fresh home and port each time: what the first `glass --detach` prints, and
 * what `glass stop` leaves. With LOBSTAH_PROBE_CLI (another build's main.js)
 * the two builds alternate, so both see the same conditions.
 */
async function glass(N, stopFile) {
  const clis = { branch: cli, ...(process.env.LOBSTAH_PROBE_CLI ? { main: path.resolve(process.env.LOBSTAH_PROBE_CLI) } : {}) };
  const blank = () => ({ runs: 0, firstSaidAlready: 0, firstFailed: 0, notRunningAfterStart: 0, stopSaidNotRunning: 0, stateLeftAfterStop: 0, answeringAfterStop: 0, pidAliveAfterStop: 0, homeBusyAfterStop: 0 });
  const outs = Object.fromEntries(Object.keys(clis).map((k) => [k, blank()]));
  const odd = [];
  for (let i = 0; i < N && !(stopFile && fs.existsSync(stopFile)); i++) {
    for (const [label, main] of Object.entries(clis)) {
      const out = outs[label];
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-probe-'));
      const port = await freePort();
      fs.writeFileSync(path.join(home, 'config.toml'), `[glass]\nport = ${port}\n`);
      const env = { ...process.env, LOBSTAH_HOME: home };
      const run = (...args) => spawnSync(process.execPath, [main, ...args], { env, encoding: 'utf8', timeout: 30_000 });
      const first = run('glass', '--detach');
      const info = await version(port);
      const stop = run('glass', 'stop');
      const after = await version(port);
      const stateLeft = fs.existsSync(path.join(home, 'state', 'glass.json'));
      const alive = info?.pid ? !pidGone(info.pid) : false;
      let busy = false;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { busy = true; }
      out.runs++;
      const already = first.stdout.includes('already');
      if (already) out.firstSaidAlready++;
      if (first.status !== 0) out.firstFailed++;
      if (!info) out.notRunningAfterStart++;
      if (!stop.stdout.includes('glass: stopped')) out.stopSaidNotRunning++;
      if (stateLeft) out.stateLeftAfterStop++;
      if (after) out.answeringAfterStop++;
      if (alive) out.pidAliveAfterStop++;
      if (busy) out.homeBusyAfterStop++;
      if (already || first.status !== 0 || !info || stateLeft || after || alive || busy) {
        odd.push({ label, i, first: (first.stdout + first.stderr).trim(), running: info?.pid, stop: (stop.stdout + stop.stderr).trim(), stateLeft, after: after?.pid, alive, busy });
      }
      // Leave nothing behind.
      for (const pid of [info?.pid, after?.pid]) if (pid && !pidGone(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      for (let t = 0; t < 100 && fs.existsSync(home); t++) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { await sleep(50); } }
    }
  }
  console.log('glass first launch and stop, fresh home and port each run:');
  console.table(outs);
  for (const o of odd.slice(0, 16)) console.log('  odd:', JSON.stringify(o));
}

if (mode === 'ebusy') await ebusy(N);
else if (mode === 'powershell') await powershell(N, process.argv[4] ?? 'idle');
else if (mode === 'powershell-watch') await powershellWatch(process.argv[3], process.argv[4] ?? 'load');
else if (mode === 'glass') await glass(N, process.argv[4]);
else throw new Error(`unknown mode ${mode}`);
