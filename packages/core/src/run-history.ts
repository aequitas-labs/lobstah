import fs from 'node:fs';
import * as path from 'node:path';
import { archivedDecisionDir, decisionDir, decisionsRoot, readDecision } from './decisions.js';
import { atomicRenameSync, uniqueTempPath } from './paths.js';

/** A run attempt stays on the card until the person dismisses it. */
export type RunState = 'running' | 'succeeded' | 'failed' | 'stopped';

/** The result shared with the glass and the helm, without private output. */
export interface RunResult {
  exitCode: number;
  timedOut: boolean;
  stopped?: boolean;
  interrupted?: boolean;
  durationMs: number;
  outputBytes: number;
  scrubbed: number;
}

/** One immutable attempt identity with durable progress and terminal metadata. */
export interface RunAttempt {
  id: string;
  key: string;
  scriptSha256: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  result?: RunResult;
  /** Stream offset retained when the saved output is shorter than the live stream. */
  outputChars?: number;
  /** OS identities keep restart recovery from signalling a reused pid. */
  owner?: import('./harness-process.js').HarnessProcess;
  processes?: import('./harness-process.js').HarnessProcess[];
}

/** Resolve only stored decision directories, including a card withdrawn during execution. */
export function runHistoryDir(key: string): string | undefined {
  const cardDir = readDecision(key) ? decisionDir(key) : archivedDecisionDir(key);
  return cardDir && fs.existsSync(cardDir) ? path.join(cardDir, 'run') : undefined;
}

/** The latest attempt survives page reloads and glass restarts. */
export function readRunAttempt(key: string): RunAttempt | undefined {
  const dir = runHistoryDir(key);
  if (!dir) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')) as RunAttempt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Find retained attempts at glass startup, including cards withdrawn while their command ran. */
export function listRunAttempts(): RunAttempt[] {
  const attempts: RunAttempt[] = [];
  for (const root of [decisionsRoot(), path.join(decisionsRoot(), '.withdrawn')]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9]{8}$/.test(entry)) continue;
      const attempt = readRunAttempt(`decision:${entry}`);
      if (attempt) attempts.push(attempt);
    }
  }
  return attempts;
}

/** Keep at most 200 lines and 256 KiB of scrubbed output for the local person view. */
export function runOutputTail(output: string): string {
  return output
    .split('\n')
    .slice(-201)
    .join('\n')
    .slice(-256 * 1024);
}

/** Store each attempt and its output before updating the card's latest pointer. */
export function writeRunAttempt(attempt: RunAttempt, output: string): void {
  if (!/^[a-f0-9-]{36}$/.test(attempt.id)) throw new Error('The run card is no longer available.');
  // A withdrawal can move the directory during a write from another process.
  for (let location = 0; location < 2; location++) {
    const dir = runHistoryDir(attempt.key);
    if (!dir) throw new Error('The run card is no longer available.');
    try {
      const attemptDir = path.join(dir, attempt.id);
      fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
      const files: Array<[string, string]> = [
        [path.join(attemptDir, 'output.log'), runOutputTail(output)],
        [path.join(attemptDir, 'state.json'), JSON.stringify(attempt, null, 2)],
        [path.join(dir, 'latest.json'), JSON.stringify(attempt, null, 2)],
      ];
      for (const [file, text] of files) {
        const temporary = uniqueTempPath(file);
        fs.writeFileSync(temporary, text, { mode: 0o600 });
        atomicRenameSync(temporary, file);
      }
    } catch (error) {
      if (dir === runHistoryDir(attempt.key)) throw error;
    }
    if (dir === runHistoryDir(attempt.key)) return;
  }
  throw new Error('The run history moved. Reload the card.');
}

/** Read output through the local run endpoint, separately from snapshots and helm events. */
export function readRunOutput(attempt: RunAttempt): string {
  const dir = runHistoryDir(attempt.key);
  if (!dir || !/^[a-f0-9-]{36}$/.test(attempt.id)) return '';
  try {
    return fs.readFileSync(path.join(dir, attempt.id, 'output.log'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
