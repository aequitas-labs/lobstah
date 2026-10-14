import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backendScope, backendScopes, BackendError, wharfFor, wharfCredential, refreshHostedViews, isVerb, waitingFields, toonKV,
  readBrokerAgent, brokerRequest, WharfBackend, type BrokerPoll } from '@lobstah/core';
import type { BackendScope, Config, ReportInput } from '@lobstah/core';
import { resolveSessionId } from './session-id.js';
import { wharfRepoIdentity } from './wharf-repo.js';
import { wharfLogin } from './wharf-login.js';
import { brokerBody, endBrokerAgent, waitBrokerAgent, wharfSoak } from './wharf-soak.js';
import { readHookStdin } from './soak-site.js';

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
  const agentScope = backendScopes(config).find((s) => s.kind === 'wharf' && readBrokerAgent(s.grounds));
  if (agentScope && OVERVIEW.has(cmd)) throw new Error('a hosted trap sees only its own catch; use inbox or wharf receipt');
  if (!grounds && OVERVIEW.has(cmd) && !pos.length) { await refreshHostedViews(config); return false; }
  const boundScope = grounds ? undefined : agentScope;
  const scope = boundScope ?? commandScope(config, grounds, opts.opt('--repo'));
  if (agentScope && scope?.grounds !== agentScope.grounds) throw new Error('a hosted trap cannot select another grounds or boat credential');
  if (!scope) {
    if (backendScopes(config).some((s) => s.kind === 'wharf')) throw new Error('choose --grounds for this command; no implicit local or wharf backend');
    return false;
  }
  if (scope.kind === 'local') {
    if (cmd === 'wharf' && ['login', 'logout'].includes(pos[0] ?? '')) throw new Error('login requires configured wharf grounds');
    if (cmd === 'dispatch' && opts.opt('--boat')) throw new Error('--boat addressing requires wharf grounds; nothing was queued locally');
    return false;
  }
  const agent = readBrokerAgent(scope.grounds);
  if (cmd === 'wharf' && ['login', 'logout'].includes(pos[0] ?? '')) {
    if (agent) throw new Error('a trap session cannot enroll or read a boat credential');
    if (pos.length !== 1) throw new Error('login/logout acts only as this boat; no positional boat argument');
    await wharfLogin(scope, pos[0]!, opts); return true;
  }
  if (cmd === 'soak') { await wharfSoak(scope, opts); return true; }
  const session = resolveSessionId({ flag: opts.opt('--session') })?.id ?? agent?.session;
  if (agent && session !== agent.session) throw new Error('another hosted session owns this worktree');
  if (cmd === 'stow' && agent) { await endBrokerAgent(agent); console.log(JSON.stringify({ stowed: agent.trap, worktree: agent.worktree })); return true; }
  const worker = opts.opt('--worker');
  let backend: WharfBackend;
  if (agent) {
    if (cmd.startsWith('man:')) throw new Error('a trap cannot hold or use the helm seat');
    const current = await brokerRequest<BrokerPoll>('heartbeat', brokerBody(agent));
    if (!current.claim?.token) throw new Error('this trap has no catch; run lobstah soak --wait through the boat daemon');
    backend = new WharfBackend(scope.location, current.claim.token);
  } else backend = wharfFor(scope, { session, worker });
  const key = () => {
    const value = opts.opt('--request-key') ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('request key must use 1–128 identifier characters'); return value;
  };
  const partKey = (base: string, part: string) => createHash('sha256').update(`${base}:${part}`).digest('hex');
  const id = () => { if (!pos[0]) throw new Error(`${cmd} requires a dispatch id`); return encodeURIComponent(pos[0]); };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const noFiles = () => { if (opts.values('--attach').length || opts.opt('--report')) throw new Error('upload wharf evidence with wharf upload, then report --file-id; local attachment paths are never sent'); };
  const readFile = (file: string, max = 25 * 1024 * 1024) => {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size > max) throw new Error('file is not regular or exceeds the upload limit');
    const bytes = fs.readFileSync(file); if (bytes.length > max) throw new Error('file exceeds the upload limit'); return bytes;
  };
  const documentId = (value: string) => value.replace(/^(decision|report):/, '');
  const fileDocument = async (kind: 'decision' | 'report') => {
    if (pos.length > 1) throw new Error('man ask/file takes at most one positional argument');
    const title = opts.opt('--title') ?? (kind === 'report' && pos[0] ? path.basename(pos[0], path.extname(pos[0])) : undefined);
    if (!title) throw new Error('man ask requires --title; man file requires a markdown file');
    const markdown = kind === 'report' ? pos[0] : opts.opt('--detail');
    const contents = markdown ? readFile(markdown, 65536) : undefined;
    if (kind === 'report' && !contents) throw new Error('man file requires a markdown file');
    const attached = opts.values('--attach').map((file) => ({ name: path.basename(file), bytes: readFile(file) }));
    if (attached.length > 32 || new Set(attached.map((f) => f.name)).size !== attached.length) throw new Error('at most 32 attachments, with different basenames');
    const base = key(), id = opts.opt('--id') ?? partKey(base, 'document').slice(0, 32);
    await backend.request('documents', { id, kind, title, options: kind === 'decision' ? opts.values('--option') : [], ...(kind === 'decision' && pos[0] ? { dispatch: pos[0] } : {}) }, partKey(base, 'create'));
    const detail = contents ? await backend.uploadDocument(id, kind === 'decision' ? 'detail.md' : 'report.md', contents, partKey(base, 'markdown')) : undefined;
    const files: string[] = [];
    for (const [i, file] of attached.entries()) files.push(await backend.uploadDocument(id, file.name, file.bytes, partKey(base, `file-${i}`)));
    print(await backend.request(`documents/${encodeURIComponent(id)}/publish`, { markdown: detail, attachments: files,
      ...(opts.opt('--replace') ? { replace: documentId(opts.opt('--replace')!) } : {}) }, partKey(base, 'publish')));
  };
  const boatId = async (name: string | undefined): Promise<string> => {
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('choose a validated boat name');
    const boats = await backend.request('boats');
    if (!Array.isArray(boats)) throw new Error('invalid boat list');
    const found = boats.find((b) => b && typeof b === 'object' && b.name === name.toLowerCase());
    if (!found || typeof found.id !== 'string') throw new Error(`boat ${name} not found; enroll it with wharf login on that boat`);
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
      const verb = pos[1]; if (!verb || !isVerb(verb)) throw new Error('report requires one of the six verbs');
      const waiting = waitingFields(verb, { waitingOn: opts.opt('--waiting-on'), link: opts.opt('--link'), until: opts.opt('--until') });
      const files = [...opts.values('--file-id')], base = key();
      const reportFile = opts.opt('--report');
      if (files.length + opts.values('--attach').length + Number(!!reportFile) > 32) throw new Error('at most 32 evidence files');
      if (reportFile) files.unshift(await backend.upload(pos[0] ?? '', 'report.md', readFile(reportFile, 65536), partKey(base, 'markdown')));
      for (const [i, file] of opts.values('--attach').entries()) files.push(await backend.upload(pos[0] ?? '', path.basename(file), readFile(file), partKey(base, `file-${i}`)));
      const r: ReportInput = { verb, ...(pos.length > 2 ? { note: pos.slice(2).join(' ') } : {}), ...waiting,
        evidence: { prUrls: opts.values('--pr'), files } };
      await backend.report(pos[0] ?? '', r, base);
      if (agent) await brokerRequest(verb === 'done' || verb === 'failed' ? 'finish' : 'progress', { ...brokerBody(agent), dispatch: pos[0] });
      print({ reported: verb }); break;
    }
    case 'man:ask': {
      const withdraw = opts.opt('--withdraw');
      if (withdraw) {
        if (pos.length || opts.opt('--title')) throw new Error('--withdraw takes only a decision key');
        print(await backend.request(`documents/${encodeURIComponent(documentId(withdraw))}/withdraw`, {}, key()));
      }
      else await fileDocument('decision'); break;
    }
    case 'man:file': await fileDocument('report'); break;
    case 'man:tend': print({ dispatches: await backend.list(), ...await backend.request('glass') as Record<string, unknown> }); break;
    case 'man:helm': print(await backend.request('helm/take', { session, take: opts.has('--take') }, key())); break;
    case 'man:relieve': print(await backend.request('helm/release', {}, key())); break;
    case 'man:throw': {
      if (!opts.has('--new') || pos.length || opts.has('--all') || opts.has('--dry-run') || opts.opt('--harness') || opts.opt('--count'))
        throw new Error('wharf throw supports --new --repo only; the boat chooses configured harness options');
      await backend.request('helm/renew', {}, key());
      print(await brokerRequest('launch', { grounds: scope.grounds, repo: opts.opt('--repo') })); break;
    }
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
    case 'wharf': {
      switch (pos[0]) {
        case 'whoami':
          if (pos.length !== 1) throw new Error('whoami acts only as the current boat; no boat argument');
          print(await backend.request('_boat')); break;
        case 'requests': print(await backend.request('requests')); break;
        case 'request-receipt': print(await backend.request(`requests/${encodeURIComponent(pos[1] ?? '')}/receipt`, {}, key())); break;
        case 'request-execute': print(await backend.request(`requests/${encodeURIComponent(pos[1] ?? '')}/execute`, {}, key())); break;
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
  if (!(cmd === 'hook' || (cmd === 'soak' && args[0] === 'beat') || cmd === 'man:brief' || cmd === 'man:haul')) return false;
  const { loadConfig } = await import('@lobstah/core');
  let config: Config;
  try { config = loadConfig(); } catch { return false; } // Existing local hook owns broken-config handling.
  const bound = backendScopes(config).find((s) => s.kind === 'wharf' && readBrokerAgent(s.grounds));
  if (!process.env.LOBSTAH_GROUNDS && !bound) return false; // Do not consume local hooks' stdin.
  const scope = bound ?? commandScope(config, process.env.LOBSTAH_GROUNDS);
  if (scope?.kind !== 'wharf') return false;
  const input = readHookStdin(), agent = readBrokerAgent(scope.grounds, input?.cwd ?? process.cwd());
  try {
    if (agent) {
      if (input?.session_id && input.session_id !== agent.session) return true;
      if (args[0] === 'session-end') await endBrokerAgent(agent);
      else if (args[0] === 'post-tool-use' || (cmd === 'soak' && args[0] === 'beat')) await brokerRequest('heartbeat', brokerBody(agent));
      else if (args[0] === 'stop' || cmd === 'man:haul') {
        const p = await waitBrokerAgent(agent, 600);
        console.log(JSON.stringify({ decision: 'block', reason: p.claim
          ? `Hosted trap ${agent.trap} assigned dispatch ${p.claim.dispatch.id}. Branch first in ${agent.worktree}; report working, then work and report done/failed.\n${p.claim.dispatch.brief}`
          : p.messages?.length ? `New inbox messages for ${p.dispatch}:\n${p.messages.map((m) => `${m.id}: ${m.text}`).join('\n')}\nReceipt explicitly with lobstah wharf receipt.`
          : 'This hosted trap is still signed on; its park timed out. End this turn and park again.' }));
      } else if (args[0] === 'session-start') console.log(`lobstah: hosted trap ${agent.trap}, session ${input?.session_id ?? agent.session}. Its boat daemon owns claim/renew; never use a boat credential.`);
      return true;
    }
    const token = wharfCredential(scope);
    if (args[0] === 'post-tool-use' || (cmd === 'soak' && args[0] === 'beat')) {
      const pieces = token.split('.');
      if (pieces[0] === 'd' && pieces[1] === scope.location.account && pieces[2]) await wharfFor(scope).heartbeat(pieces[2], randomUUID());
    } else if (args[0] === 'session-start' || cmd === 'man:brief') {
      console.log(`lobstah: wharf grounds ${scope.grounds} on ${scope.wharf}, session ${input?.session_id ?? 'unknown'}. Use --session on first soak. Report and read messages through this grounds; receipt messages explicitly with lobstah wharf receipt. Do not sign on to the local fleet. The boat daemon owns claim and lease renewal.`);
    }
  } catch { /* Missing remote signal means unknown; hooks never break a user's turn. */ }
  return true;
}
