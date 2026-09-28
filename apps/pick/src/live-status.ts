import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  laneDirs, loadConfig, readActivity, readEvidence, readStatusLog,
  redactSummary, storedDescriptor,
} from '@lobstah/core';
import type { Lane, Verb } from '@lobstah/core';
import { marker } from './types.js';

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function git(worktree: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

/** Only local, already-redacted activity and short git metadata reach a tracker. */
export function liveStatus(id: string, lane: Lane, verb: Verb, createdAt: string, now = Date.now()): { body: string; fingerprint: string } {
  const cfg = loadConfig();
  const descriptor = storedDescriptor(id, lane);
  const evidence = readEvidence(id, lane);
  const last = readStatusLog(id, lane).at(-1);
  const lines = [`${marker(id)} **${verb}${verb === 'paused' && last?.waitingOn ? `: waiting on ${last.waitingOn}` : ''}**`];
  const fingerprint = [lines[0]!];
  if (verb === 'paused' && last?.link) lines.push(`waiting link: ${last.link}`);
  if (verb === 'paused' && last?.link) fingerprint.push(`waiting link: ${last.link}`);

  const activity = readActivity(id, lane);
  if (activity) {
    const secs = Math.max(0, Math.floor((now - (Date.parse(activity.at) || now)) / 1000));
    const stale = secs > cfg.limits.wedgeThresholdSecs ? ' (stale)' : '';
    lines.push(`activity: ${activity.summary} ${age(secs)} ago${stale}`);
    fingerprint.push(`activity: ${activity.at} ${activity.summary}${stale}`);
  }
  const elapsed = Math.max(0, Math.floor((now - (Date.parse(createdAt) || now)) / 1000));
  let attempts = 1;
  try {
    const runner = JSON.parse(fs.readFileSync(path.join(laneDirs(lane).active, id, 'runner.json'), 'utf8')) as { attempts?: number };
    attempts = runner.attempts ?? 1;
  } catch { /* queued or finished */ }
  lines.push(`elapsed: ${age(elapsed)}${attempts > 1 ? ` (attempt ${attempts})` : ''}`);

  const worktree = evidence.worktree;
  const branch = (worktree && git(worktree, 'branch', '--show-current')) || evidence.branch;
  if (branch) lines.push(`branch: \`${branch}\``);
  if (branch) fingerprint.push(`branch: ${branch}`);
  const commit = worktree && git(worktree, 'log', '-1', '--format=%h %s');
  if (commit) lines.push(`last commit: ${redactSummary(commit)}`);
  else if (evidence.commits?.length) lines.push(`last commit: ${redactSummary(evidence.commits[0]!)}`);
  fingerprint.push(lines.at(-1)?.startsWith('last commit:') ? lines.at(-1)! : '');
  const trunk = descriptor && cfg.repos[descriptor.repo]?.trunk;
  const ahead = worktree && trunk && git(worktree, 'rev-list', '--count', `origin/${trunk}..HEAD`);
  if (ahead !== undefined && trunk) lines.push(`ahead of ${trunk}: ${ahead} commit${ahead === '1' ? '' : 's'}`);
  if (ahead !== undefined && trunk) fingerprint.push(`ahead of ${trunk}: ${ahead}`);
  if (evidence.prUrl) lines.push(`draft PR: ${evidence.prUrl}`);
  if (evidence.prUrl) fingerprint.push(`draft PR: ${evidence.prUrl}`);
  lines.push(`updated ${new Date(now).toISOString()}`);
  return { body: lines.join('\n'), fingerprint: fingerprint.join('\n') };
}
