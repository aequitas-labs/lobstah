import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeEvidence, readEvidence, readSessionClaim, resolveOnPath } from '@lobstah/core';
import type { Lane } from '@lobstah/core';

const exec = promisify(execFile);

export interface RemotePolicy {
  pushEarly: boolean;
  draftPr: boolean;
  checkpointOnStop: boolean;
}

export interface RemoteRun {
  stop(): Promise<void>;
  saveBeforeStop(): Promise<string>;
}

function firstLine(err: unknown): string {
  const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : '';
  return (stderr || (err instanceof Error ? err.message : String(err))).replace(/\s+/g, ' ').slice(0, 240);
}

/** Only source-like files enter an automatic checkpoint; ignored files never enter the candidate set. */
export function checkpointAllowed(file: string): boolean {
  const parts = file.toLowerCase().split('/');
  const base = parts.at(-1) ?? '';
  if (parts.some((p) => ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo'].includes(p))) return false;
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12')) return false;
  if (/^(credentials?|secrets?|id_rsa|id_ed25519)(\.|$)/.test(base)) return false;
  return true;
}

/** Keep committed headless work on origin while the worker runs; never force-push or touch trunk. */
export function keepRemote(opts: {
  id: string;
  lane: Lane;
  cwd: string;
  trunk: string;
  title: string;
  policy: RemotePolicy;
  intervalMs?: number;
}): RemoteRun {
  const { id, lane, cwd, trunk, policy } = opts;
  const command = async (bin: string, args: string[], timeout = 120_000): Promise<string> => {
    const file = bin === 'gh' ? (resolveOnPath('gh') ?? bin) : bin;
    return (await exec(file, args, {
      cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file),
    })).stdout.trim();
  };
  const git = (...args: string[]) => command('git', args);
  const note = (message: string) => mergeEvidence(id, lane, { note: message.slice(0, 300) });
  let lastSeenHead: string | undefined;
  let pushedHead: string | undefined;
  let busy: Promise<void> | undefined;
  let stopped = false;
  let opened = false;
  let opening: Promise<void> | undefined;
  let pushProblem: string | undefined;
  let draftProblem: string | undefined;
  const trapClaimed = () => readSessionClaim(id, lane)?.by?.startsWith('wt:') === true;

  const branchName = async (): Promise<string | undefined> => {
    const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
    if (!branch || branch === trunk || branch === `origin/${trunk}`) return undefined;
    return branch;
  };

  const draft = async (branch: string): Promise<void> => {
    if (!policy.draftPr || opened || readEvidence(id, lane).prUrl) return;
    let url = '';
    try { url = await command('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url']); } catch { /* no PR yet */ }
    if (!url) {
      try {
        url = await command('gh', ['pr', 'create', '--draft', '--base', trunk, '--head', branch,
          '--title', opts.title.slice(0, 120), '--body', `Work in progress for lobstah dispatch ${id}.`]);
      } catch (err) {
        draftProblem = `draft PR unavailable: ${firstLine(err)}`;
        note(draftProblem);
        return;
      }
    }
    const match = url.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (!match) return;
    opened = true;
    draftProblem = undefined;
    mergeEvidence(id, lane, { prUrl: match[0] });
    // The CLI owns PR-watch formatting. An absent CLI must not block pushes.
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'lobstah');
    await command(fs.existsSync(bin) ? bin : 'lobstah', ['watch', 'add', match[0], '--for', id], 15_000).catch(() => {});
  };

  const check = async (): Promise<void> => {
    if (!policy.pushEarly || trapClaimed()) return;
    const branch = await branchName();
    if (!branch) return;
    const head = await git('rev-parse', 'HEAD');
    // If origin is absent, try the push once so Git's actual error reaches the status note.
    const ahead = await git('rev-list', '--count', `origin/${trunk}..HEAD`).catch(() => '1');
    if (ahead === '0') return;
    if (head === lastSeenHead) return; // rejected push retries only after HEAD moves
    lastSeenHead = head;
    if (head === pushedHead) return;
    try {
      await git('push', '-u', 'origin', branch);
      pushedHead = head;
      pushProblem = undefined;
      mergeEvidence(id, lane, { branch });
      note(`remote saved: ${branch}@${head.slice(0, 12)}`);
      if (!opening) opening = draft(branch).finally(() => { opening = undefined; });
    } catch (err) {
      pushProblem = `push rejected for ${branch}@${head.slice(0, 12)}: ${firstLine(err)}; retry after HEAD moves`;
      note(pushProblem);
    }
  };

  const poll = () => {
    if (busy || stopped) return;
    busy = check().catch((err) => note(`remote check unavailable: ${firstLine(err)}`)).finally(() => { busy = undefined; });
  };
  if (policy.pushEarly) poll();
  const timer = setInterval(poll, Math.min(10_000, Math.max(1000, opts.intervalMs ?? 10_000)));
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await busy;
      await check().catch((err) => note(`final push unavailable: ${firstLine(err)}`));
      await opening;
    },
    saveBeforeStop: async () => {
      stopped = true;
      clearInterval(timer);
      await busy;
      if (trapClaimed()) return 'checkpoint skipped: trap-claimed dispatch';
      const branch = await branchName();
      if (!branch) {
        const message = 'checkpoint skipped: detached or trunk; files left in place';
        note(message);
        return message;
      }
      let saved = 'no working-tree changes';
      if (policy.checkpointOnStop) {
        try {
          const paths = (await git('ls-files', '-m', '-o', '-d', '--exclude-standard', '-z'))
            .split('\0').filter(Boolean).filter(checkpointAllowed);
          if (paths.length) {
            await git('add', '-A', '--', ...paths);
            const staged = await git('diff', '--cached', '--name-only', '--', ...paths);
            if (staged) {
              await git('commit', '--only', '-m', 'Checkpoint before runner stop', '--', ...paths);
              saved = `checkpoint committed (${staged.split('\n').length} files)`;
            }
          }
        } catch (err) { saved = `checkpoint unavailable: ${firstLine(err)}`; }
      }
      // A checkpoint changes HEAD, so check() will retry naturally; a rejected
      // push of the same HEAD must not be retried on this stop path.
      await check().catch((err) => note(`final push unavailable: ${firstLine(err)}`));
      await opening;
      const head = await git('rev-parse', '--short', 'HEAD').catch(() => 'unknown');
      const pr = readEvidence(id, lane).prUrl;
      const message = `${saved}; ${branch}@${head}${pr ? `; draft PR ${pr}` : ''}${pushProblem ? `; ${pushProblem}` : ''}${draftProblem ? `; ${draftProblem}` : ''}`;
      note(message);
      return message;
    },
  };
}
