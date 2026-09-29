import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeEvidence, readEvidence } from './evidence.js';
import type { Lane } from './types.js';

/**
 * Pushes a dispatch made, as lobstah saw them: the runner's own pushes, a
 * headless worker's `git push` commands (from the harness event stream),
 * and a trap's `git push` commands (from its post-tool beat). GitHub is
 * never read to guess who pushed. The record lives in the dispatch's
 * evidence, so it covers the current dispatch only.
 */
export interface PushRecord {
  branch: string;
  /** The last push to this branch (ISO). */
  at: string;
}

/** The most branches one dispatch records. */
const MAX_PUSHES = 20;

/** `HEAD` in a push target: the branch checked out where the command ran. */
export const PUSH_HEAD = 'HEAD';

/** Options of `git push` that take a separate value. */
const VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function branchOf(ref: string): string {
  const name = ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');
  return name === '@' || name === '' ? PUSH_HEAD : name;
}

/**
 * The branches one shell command pushes, or undefined when it runs no
 * `git push`. A push with no refspec pushes `HEAD`. A refspec `src:dst`
 * pushes `dst`.
 */
export function gitPushTargets(command: string | readonly string[] | undefined): string[] | undefined {
  if (command === undefined) return undefined;
  const text = typeof command === 'string' ? command : command.join(' ');
  if (!/\bgit\b[^\n]*\bpush\b/.test(text)) return undefined;
  const targets: string[] = [];
  let found = false;
  for (const segment of text.split(/&&|\|\||[;|\n]/)) {
    const w = words(segment);
    let i = w.findIndex((x) => x === 'git' || /[\\/]git(?:\.exe)?$/.test(x));
    if (i < 0) continue;
    // git's own options before the subcommand: -C <dir>, -c <k=v>, --flags.
    for (i++; i < w.length && w[i]!.startsWith('-'); i++) if (w[i] === '-C' || w[i] === '-c') i++;
    if (w[i] !== 'push') continue;
    found = true;
    const positional: string[] = [];
    for (let j = i + 1; j < w.length; j++) {
      const arg = w[j]!;
      if (arg === '--') continue;
      if (arg.startsWith('-')) {
        if (VALUE_OPTIONS.has(arg)) j++;
        continue;
      }
      positional.push(arg);
    }
    const refspecs = positional.slice(1);
    if (refspecs.length === 0) targets.push(PUSH_HEAD);
    for (const spec of refspecs) targets.push(branchOf(spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec));
  }
  return found ? [...new Set(targets)] : undefined;
}

/** The directory's git dir: `.git` itself, or the path a worktree's `.git` file names. */
function gitDirAt(dir: string): string | undefined {
  let at = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(at, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      return m ? path.resolve(at, m[1]!.trim()) : undefined;
    } catch {
      /* not here */
    }
    const up = path.dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** The branch checked out at `dir`, read from files. Undefined when detached or not a checkout. */
export function currentBranchAt(dir: string): string | undefined {
  const gitDir = gitDirAt(dir);
  if (!gitDir) return undefined;
  try {
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'));
    return m ? m[1]!.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Replace `HEAD` targets with the branch checked out at `cwd`; drop them when it is unknown. */
export function resolvePushTargets(targets: readonly string[], cwd: string | undefined): string[] {
  const head = cwd ? currentBranchAt(cwd) : undefined;
  return [...new Set(targets.flatMap((t) => (t === PUSH_HEAD ? (head ? [head] : []) : [t])))];
}

/** Record pushes to these branches in the dispatch's evidence. */
export function recordPush(id: string, lane: Lane, branches: readonly string[], at = new Date().toISOString()): void {
  if (branches.length === 0) return;
  const kept = (readEvidence(id, lane).pushes ?? []).filter((p) => !branches.includes(p.branch));
  const pushes = [...kept, ...branches.map((branch) => ({ branch, at }))].slice(-MAX_PUSHES);
  mergeEvidence(id, lane, { pushes });
}
