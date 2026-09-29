import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Ports for tests that start a real server on a port they must know in advance.
 *
 * `listen(0)` then `close()` is not a reservation. The port goes back to the
 * ephemeral pool at once, and any parallel test file that calls `listen(0)`
 * can receive it. Several test files run an in-process glass on `listen(0)`.
 *
 * These ports come from 20000–29999. That range is below the ephemeral range
 * of every OS we test on (Linux 32768–60999; Windows and macOS 49152–65535),
 * so no `listen(0)` and no outgoing connection lands on them. A lock file makes
 * a reservation exclusive across processes, including two suites that run at
 * the same time. A lock whose owner has exited is reclaimed. A bind check skips
 * a port that something already holds, such as a leaked server or a Windows
 * excluded port range.
 */
const FIRST = 20_000;
const COUNT = 10_000;
const lockDir = path.join(os.tmpdir(), 'lobstah-test-ports');

export interface ReservedPort {
  port: number;
  /** Frees the port for other tests. Call it only after the server on it has exited. */
  release(): void;
}

export async function reservePort(): Promise<ReservedPort> {
  fs.mkdirSync(lockDir, { recursive: true });
  const start = Math.floor(Math.random() * COUNT);
  for (let i = 0; i < COUNT; i++) {
    const port = FIRST + ((start + i) % COUNT);
    const lock = path.join(lockDir, `${port}.lock`);
    if (!takeLock(lock)) continue;
    if (await bindable(port)) return { port, release: () => fs.rmSync(lock, { force: true }) };
    fs.rmSync(lock, { force: true });
  }
  throw new Error(`no free test port in ${FIRST}–${FIRST + COUNT - 1}`);
}

function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = Number.parseInt(readOrEmpty(lock), 10);
    // An empty file is a lock that another process is still writing.
    if (!Number.isInteger(owner) || owner <= 0 || pidAlive(owner)) return false;
    fs.rmSync(lock, { force: true }); // its owner exited without releasing it
  }
  return false;
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stops a process the test started and waits until it has exited. Only then
 * are its open files closed, so the test's temp home can be removed (Windows).
 */
export async function killAndWait(pid: number): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!pidAlive(pid)) return;
    try {
      process.kill(pid, signal);
    } catch {
      // it exited between the check and the signal
    }
    const deadline = Date.now() + 5000;
    while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (pidAlive(pid)) throw new Error(`test process ${pid} did not exit`);
}
