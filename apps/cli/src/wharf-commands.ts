import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backendScope, backendScopes, BackendError, wharfFor, refreshHostedViews, isVerb, waitingFields, toonKV } from '@lobstah/core';
import type { BackendScope, Config, ReportInput } from '@lobstah/core';
import { resolveSessionId } from './session-id.js';
import { wharfRepoIdentity } from './wharf-repo.js';

export function commandScope(config: Config, grounds?: string, repo?: string): BackendScope | undefined {
  if (grounds) return backendScope(config, grounds);
  const scopes = backendScopes(config);
  if (repo) {
    const matches = scopes.filter((s) => s.repos.includes(repo));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`repo ${repo} belongs to several grounds; use --grounds`);
    if (scopes.some((s) => s.kind === 'wharf')) throw new Error(`repo ${repo} has no grounds; use a configured repo and --grounds`);
  }
  if (scopes.length === 1) return scopes[0];
  const local = scopes.filter((s) => s.kind === 'local');
  if (local.length === 1) return local[0];
  // No implicit remote writes. Fleet-wide reads use the independent caches.
  return undefined;
}
type Options = { opt: (flag: string) => string | undefined; has: (flag: string) => boolean; values: (flag: string) => string[] };
const GLOBAL = new Set(['version', 'daemon', 'glass', 'pet', 'doctor', 'telemetry', 'init', 'repos', 'pick', 'man:manual', '__runner', '__pool-warm']);
const OVERVIEW = new Set(['ls', 'status', 'man:tend', 'man:report', 'prs', 'reports', 'stats', 'attention']);
/** Resolve once per command; remote mutations can never enter local handlers. */
export async function wharfCommand(cmd: string | undefined, pos: string[], opts: Options, config: Config): Promise<boolean> {
  if (!cmd || GLOBAL.has(cmd)) return false;
  const grounds = opts.opt('--grounds') ?? process.env.LOBSTAH_GROUNDS;
  if (!grounds && OVERVIEW.has(cmd) && !pos.length) { await refreshHostedViews(config); return false; }
  const scope = commandScope(config, grounds, opts.opt('--repo'));
  if (!scope) {
    if (backendScopes(config).some((s) => s.kind === 'wharf')) throw new Error('choose --grounds for this command; no implicit local or wharf backend');
    return false;
  }
  if (scope.kind === 'local') {
    if (cmd === 'dispatch' && opts.opt('--boat')) throw new Error('--boat addressing requires wharf grounds; nothing was queued locally');
    return false;
  }
  const session = resolveSessionId({ flag: opts.opt('--session') })?.id;
  const worker = opts.opt('--worker');
  const backend = wharfFor(scope, { session, worker });
  const key = () => opts.opt('--request-key') ?? randomUUID();
  const id = () => { if (!pos[0]) throw new Error(`${cmd} requires a dispatch id`); return encodeURIComponent(pos[0]); };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const noFiles = () => { if (opts.values('--attach').length || opts.opt('--report')) throw new Error('upload wharf evidence with wharf upload, then report --file-id; local attachment paths are never sent'); };
  const permissions = () => {
    const selected = opts.values('--permission');
    if (!selected.every((p) => ['read', 'work', 'helm', 'admin'].includes(p))) throw new Error('--permission must be read, work, helm or admin');
    if (selected.includes('admin')) {
      if (!opts.has('--grant-admin')) throw new Error('admin can issue credentials and delete this account; use --grant-admin to confirm this grant');
      console.error('Warning: this boat will have admin authority, including credential management and account deletion.');
    }
    return { ...(selected.length ? { permissions: selected } : {}), ...(opts.has('--grant-admin') ? { confirmAdmin: true } : {}) };
  };
  const boatId = async (name: string | undefined): Promise<string> => {
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('choose a validated boat name');
    const boats = await backend.request('boats');
    if (!Array.isArray(boats)) throw new Error('invalid boat list');
    const found = boats.find((b) => b && typeof b === 'object' && b.name === name.toLowerCase());
    if (!found || typeof found.id !== 'string') throw new Error(`boat ${name} not found; issue its credential with wharf issue-boat`);
    return found.id;
  };
  switch (cmd) {
    case 'dispatch': {
      noFiles();
      if (opts.opt('--pool')) throw new Error('local worktree pools cannot run on wharf grounds');
      const repo = opts.opt('--repo'); const file = opts.opt('--brief') ?? opts.opt('--bait');
      const brief = opts.opt('--brief-text') ?? (file ? fs.readFileSync(file, 'utf8') : undefined);
      if (!repo || !brief || !scope.repos.includes(repo)) throw new Error('dispatch needs --repo in this grounds and --brief or --brief-text');
      const targetBoat = opts.opt('--boat') ? await boatId(opts.opt('--boat')) : undefined;
      print(await backend.enqueue({ id: opts.opt('--id') ?? randomUUID(), repo, repoRemote: wharfRepoIdentity(config, repo), brief, lane: opts.has('--chore') ? 'chore' : 'work',
        ...(targetBoat ? { boat: targetBoat } : {}),
        for: opts.opt('--for')?.replace(/^wt:/, ''), followUp: opts.opt('--follow-up'), harness: opts.opt('--harness'), model: opts.opt('--model'), effort: opts.opt('--effort') }, key()));
      break;
    }
    case 'ls': print(await backend.list()); break;
    case 'status': print(await backend.request(`dispatches/${id()}`)); break;
    case 'cancel': print(await backend.request(`dispatches/${id()}/cancel`, {}, key())); break;
    case 'send': noFiles(); await backend.send(pos[0] ?? '', pos.slice(1).join(' '), key()); print({ sent: true }); break;
    case 'inbox': print(await backend.messages(pos[0] ?? '')); break; // Explicit receipt, never implicit acknowledgement.
    case 'report': {
      noFiles(); const verb = pos[1]; if (!verb || !isVerb(verb)) throw new Error('report requires one of the six verbs');
      const waiting = waitingFields(verb, { waitingOn: opts.opt('--waiting-on'), link: opts.opt('--link'), until: opts.opt('--until') });
      const r: ReportInput = { verb, ...(pos.length > 2 ? { note: pos.slice(2).join(' ') } : {}), ...waiting,
        evidence: { prUrls: opts.values('--pr'), files: opts.values('--file-id') } };
      await backend.report(pos[0] ?? '', r, key()); print({ reported: verb }); break;
    }
    case 'man:helm': print(await backend.request('helm/take', { session, take: opts.has('--take') }, key())); break;
    case 'man:relieve': print(await backend.request('helm/release', {}, key())); break;
    case 'man:wait': {
      let cursor = opts.opt('--after'); const seconds = Number(opts.opt('--timeout') ?? 600);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('timeout must be nonnegative seconds');
      const deadline = seconds ? Date.now() + seconds * 1000 : Infinity; let unknown = false; let renewed = 0;
      while (Date.now() < deadline) {
        try {
          if (Date.now() - renewed > 60_000) { await backend.request('helm/renew', {}, randomUUID()); renewed = Date.now(); }
          const batch = await backend.events(cursor); cursor = batch.cursor;
          if (batch.events.length) { print(batch); return true; }
          unknown = false;
        } catch (e) {
          if (!(e instanceof BackendError) || e.status !== 503) throw e;
          if (!unknown) console.error(toonKV({ grounds: scope.grounds, state: 'unknown', note: 'wharf unavailable; keeping cursor and waiting' }));
          unknown = true;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
      }
      print({ cursor, timeout: true }); break;
    }
    case 'soak': {
      if (!worker || !opts.opt('--repo')) throw new Error('wharf soak requires --worker and --repo (trusted boat credential, not an agent token)');
      if (!scope.repos.includes(opts.opt('--repo')!)) throw new Error('worker repo must belong to this grounds');
      await backend.request('workers/sign-on', { worker, repo: opts.opt('--repo'), repoRemote: wharfRepoIdentity(config, opts.opt('--repo')!) }, key());
      const seconds = Number(opts.opt('--timeout') ?? 600);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('timeout must be nonnegative seconds');
      const deadline = opts.has('--wait') ? (seconds ? Date.now() + seconds * 1000 : Infinity) : Date.now();
      do {
        const claim = await backend.claim(randomUUID()); if (claim) { print(claim); return true; }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await backend.request('workers/renew', { worker }, randomUUID());
      } while (Date.now() < deadline);
      print({ timeout: true }); process.exitCode = 3; break;
    }
    case 'wharf': {
      switch (pos[0]) {
        case 'issue-boat': print(await backend.request('boats', { name: pos[1], ...permissions() }, key())); break;
        case 'boat-permissions': {
          const chosen = permissions();
          if (!chosen.permissions && !opts.has('--clear')) throw new Error('boat-permissions requires --permission or --clear');
          print(await backend.request(`boats/${encodeURIComponent(await boatId(pos[1]))}/permissions`, { ...chosen, permissions: opts.has('--clear') ? [] : chosen.permissions }, key())); break;
        }
        case 'boats': print(await backend.request('boats')); break;
        case 'revoke-boat': print(await backend.request(`boats/${encodeURIComponent(await boatId(pos[1]))}/revoke`, {}, key())); break;
        case 'rename-boat': print(await backend.request(`boats/${encodeURIComponent(await boatId(pos[1]))}/rename`, { name: pos[2] }, key())); break;
        case 'remove-boat':
          if (!opts.has('--confirm')) throw new Error('remove-boat requires --confirm; open addressed work must be cancelled first');
          print(await backend.request(`boats/${encodeURIComponent(await boatId(pos[1]))}`, {}, key(), 'DELETE')); break;
        case 'renew': print(await backend.request('workers/renew', { worker }, key())); break;
        case 'heartbeat': await backend.heartbeat(pos[1] ?? '', key()); print({ renewed: true }); break;
        case 'receipt': await backend.receipt(pos[1] ?? '', pos[2] ?? '', key()); print({ received: true }); break;
        case 'upload': {
          const file = pos[2]; if (!file) throw new Error('wharf upload <dispatch> <file>');
          if (fs.statSync(file).size > 25 * 1024 * 1024) throw new Error('file exceeds 25 MiB');
          print({ file: await backend.upload(pos[1] ?? '', path.basename(file), fs.readFileSync(file), key()) }); break;
        }
        case 'recover': {
          print(await backend.request(`dispatches/${encodeURIComponent(pos[1] ?? '')}/recovery`, JSON.parse(fs.readFileSync(pos[2] ?? '', 'utf8')), key()));
          break;
        }
        case 'recoveries': print(await backend.request(`dispatches/${encodeURIComponent(pos[1] ?? '')}/recoveries`)); break;
        case 'delete-account':
          if (!opts.has('--confirm')) throw new Error('delete-account requires --confirm; removes all account rows and files');
          print(await backend.request('', {}, key(), 'DELETE')); break;
        default: throw new Error('choose a wharf subcommand');
      }
      break;
    }
    default: throw new Error(`${cmd} is not supported on wharf grounds; nothing was written locally`);
  }
  return true;
}

/** Remote agents must never sign on, beat or claim in this boat's local fleet. */
export async function wharfHook(cmd: string | undefined, args: string[]): Promise<boolean> {
  if (!process.env.LOBSTAH_GROUNDS || !(cmd === 'hook' || (cmd === 'soak' && args[0] === 'beat') || cmd === 'man:brief' || cmd === 'man:haul')) return false;
  const { loadConfig } = await import('@lobstah/core');
  const scope = commandScope(loadConfig(), process.env.LOBSTAH_GROUNDS);
  if (scope?.kind !== 'wharf') return false;
  try {
    const token = process.env[scope.location.tokenEnv] ?? '';
    if (args[0] === 'post-tool-use' || (cmd === 'soak' && args[0] === 'beat')) {
      const pieces = token.split('.');
      if (pieces[0] === 'd' && pieces[1] === scope.location.account && pieces[2]) await wharfFor(scope).heartbeat(pieces[2], randomUUID());
    } else if (args[0] === 'session-start' || cmd === 'man:brief') {
      console.log(`lobstah: wharf grounds ${scope.grounds} on ${scope.wharf}. Report and read messages through this grounds; receipt messages explicitly with lobstah wharf receipt. Do not sign on to the local fleet. The trusted launcher owns claim and lease renewal.`);
    }
  } catch { /* Missing remote signal means unknown; hooks never break a user's turn. */ }
  return true;
}
