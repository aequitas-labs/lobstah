import fs from 'node:fs';
import * as path from 'node:path';
import { heavyDir } from './heavy.js';
import { atomicRenameSync, uniqueTempPath } from './paths.js';

const KEEP_MS = 30 * 86_400_000;

/** Commands that are heavy whatever their arguments. */
const ALWAYS: readonly string[][] = [
  ['turbo', 'run'],
  ['pnpm', 'test'], ['pnpm', 'run', 'test'], ['npm', 'test'], ['npm', 'run', 'test'],
  ['pnpm', '-r', 'run', 'build'], ['pnpm', '-r', 'build'], ['pnpm', 'run', 'build'], ['pnpm', 'build'],
];
/** Commands that are heavy unless they name a path: `vitest run foo.test.ts` is focused. */
const WITHOUT_A_PATH: readonly string[][] = [['vitest', 'run'], ['playwright', 'test']];

const startsWith = (tokens: string[], prefix: readonly string[]) => prefix.every((p, i) => tokens[i] === p);

function firstSimpleCommand(command: string): string {
  return command.trim().replace(/^cd\s+\S+\s*&&\s*/, '').split(/[;&|<>\n]/)[0] ?? '';
}

/** The command's own words: its first simple command, past `cd`, env settings and runners. */
function commandWords(command: string): string[] {
  let tokens = firstSimpleCommand(command).trim().split(/\s+/).filter(Boolean);
  const dropWhile = (drop: (t: string, next?: string) => number) => {
    for (;;) {
      const n = tokens[0] === undefined ? 0 : drop(tokens[0], tokens[1]);
      if (n === 0) return;
      tokens = tokens.slice(n);
    }
  };
  const isSetting = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
  dropWhile((t) => (isSetting(t) ? 1 : 0));
  if (tokens[0] === 'env') {
    tokens = tokens.slice(1);
    dropWhile((t) => (t === '-u' ? 2 : t === '-i' || isSetting(t) ? 1 : 0));
  }
  if (tokens[0] === 'time') tokens = tokens.slice(1);
  tokens = tokens[0] === 'pnpm' || tokens[0] === 'npm' ? [tokens[0]!, ...tokens.slice(1).filter((t) => t !== '-s' && t !== '--silent')] : tokens;
  if (tokens[0] === 'npx' || tokens[0] === 'bunx') tokens = tokens.slice(1);
  else if (tokens[0] === 'pnpm' && (tokens[1] === 'exec' || tokens[1] === 'dlx')) tokens = tokens.slice(2);
  else if (tokens[0] === 'pnpm' && ['vitest', 'playwright', 'turbo'].includes(tokens[1] ?? '')) tokens = tokens.slice(1);
  return tokens;
}

/**
 * The known heavy command this runs, not under `lobstah heavy`, or undefined.
 * It can miss: a script that runs vitest inside, or a path that covers most of
 * the repo. A miss only leaves that run unqueued. `extra` is a repo's own names.
 */
export function heavyCommandPattern(command: string, extra: readonly string[] = []): string | undefined {
  const tokens = commandWords(command);
  if (tokens[0] === 'lobstah') return undefined;
  for (const prefix of [...ALWAYS, ...extra.map((e) => e.trim().split(/\s+/))]) {
    if (prefix.length > 0 && startsWith(tokens, prefix)) return prefix.join(' ');
  }
  for (const prefix of WITHOUT_A_PATH) {
    if (startsWith(tokens, prefix) && !tokens.slice(prefix.length).some((t) => !t.startsWith('-'))) return prefix.join(' ');
  }
  return undefined;
}

/** True the first time this dispatch runs this pattern. Unwritable state stays silent. */
export function firstHeavyReminder(dispatch: string, pattern: string, now = Date.now()): boolean {
  try {
    const dir = path.join(heavyDir(), 'reminded');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${encodeURIComponent(dispatch)}.json`);
    let seen: string[] = [];
    try {
      seen = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
    } catch {
      /* nothing reminded yet */
    }
    if (seen.includes(pattern)) return false;
    const tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, JSON.stringify([...seen, pattern]));
    atomicRenameSync(tmp, file);
    for (const name of fs.readdirSync(dir)) {
      const old = path.join(dir, name);
      if (now - fs.statSync(old).mtimeMs > KEEP_MS) fs.rmSync(old, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

export function heavyReminderText(command: string): string {
  // Only the heavy part: `lobstah heavy -- a; b` would wrap `a` alone anyway.
  const shown = firstSimpleCommand(command).trim();
  return `lobstah: this looks like a full test run or build and it wasn't queued.\nNext time use: lobstah heavy -- ${shown}`;
}
