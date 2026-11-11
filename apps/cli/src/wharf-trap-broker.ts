import { acquireDesktopLease, releaseDesktopLease, renewDesktopLease, readTrap, signOnTrap, stowTrap, heartbeatTrap, withConfiguredTrapSlot, trapBySession, type ConfiguredTrapLocation } from '@lobstah/core';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BackendError, backendScope, backendScopes, brokerAddressFile, newTrapId, reserveTrapName, uniqueTempPath,
  wharfFor, WharfBackend, type BackendMessage, type BackendScope, type BrokerAgent, type ClaimReceipt, type Config,
} from '@lobstah/core';
import { wharfRepoIdentity } from './wharf-repo.js';
import { createSoakWorktree } from './soak-worktree.js';
import { inspectSoakSite } from './soak-site.js';
import { freshProfile, harnessCommand, macTerminalAdapter, tmuxTerminalAdapter } from './throw.js';

type Scope = Extract<BackendScope, { kind: 'wharf' }>;
type Remote = Pick<WharfBackend, 'request' | 'claim'>;
type Ticket = { token: string; scope: Scope; repo?: string; configured?: ConfiguredTrapLocation; trap: string; name: string; request: string; until: number; used: boolean; worktree: string; origin?: string };
/** A one-use boat-local sign-on ticket; configured tickets carry no repository. */
export interface BrokerTicket { ticket: string; trap: string; name: string; grounds: string; worktree: string; request: string; expiresAt: string; repo?: string; configured?: ConfiguredTrapLocation }
type Session = { agent: BrokerAgent; scope: Scope; name: string; pid: number; seen: number; current: ClaimReceipt | null; reported: boolean; tail: Promise<unknown> };
export const BROKER_LIVENESS_MS = 30_000;
const secret = () => randomBytes(32).toString('hex');
const id = (v: unknown) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error('invalid broker identifier');
  return v;
};
export interface BrokerOptions {
  config: () => Config; now?: () => number; alive?: (pid: number) => boolean;
  backend?: (scope: Scope, worker?: string) => Remote;
  prepare?: (repo: string, trap: string, request: string, cwd?: string) => Promise<string>;
  launch?: (ticket: { ticket: string; trap: string; request: string; worktree: string; repo: string; grounds: string }) => Promise<void>;
  identity?: (repo: string) => string;
  inbox?: (scope: Scope, claim: ClaimReceipt) => Promise<BackendMessage[]>;
  validateClaim?: (scope: Scope, claim: ClaimReceipt) => Promise<void>;
}
/** Boat authority lives here, never in the trap's session or local response. */
export class WharfTrapBroker {
  private tickets = new Map<string, Ticket>();
  private sessions = new Map<string, Session>();
  private signingOn = new Set<string>();
  private starts = new Set<string>();
  constructor(private options: BrokerOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private alive(pid: number) {
    if (this.options.alive) return this.options.alive(pid);
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  private remote(scope: Scope, worker?: string): Remote { return (this.options.backend ?? ((s, w) => wharfFor(s, { worker: w })))(scope, worker); }
  private scope(grounds: unknown, repo: unknown): { scope: Scope; repo: string } {
    const scope = backendScope(this.options.config(), id(grounds)), key = id(repo);
    if (scope.kind !== 'wharf' || !scope.repos.includes(key) || !this.options.config().repos[key]) throw new Error('repo is not configured on this boat and grounds');
    return { scope, repo: key };
  }
  async ticket(grounds: unknown, repo: unknown, request: string = randomUUID(), cwd?: string, until = this.now() + 180_000, configuredName?: string): Promise<BrokerTicket> {
    if (configuredName) return this.configuredTicket(grounds, configuredName, request, cwd, until);
    const selected = this.scope(grounds, repo);
    id(request);
    if (!Number.isFinite(until) || until <= this.now()) throw new Error('start request expired');
    if (this.tickets.size >= 256 || this.sessions.size >= 256) throw new Error('boat broker capacity reached; wait for tickets or sessions to expire');
    const trap = newTrapId(), name = reserveTrapName(trap), token = secret();
    const worktree = await this.options.prepare!(selected.repo, trap, request, cwd);
    if (until <= this.now()) throw new Error('start request expired before launch');
    const t: Ticket = { ...selected, token, trap, name, request: id(request), until, used: false, worktree, ...(cwd ? { origin: cwd } : {}) };
    this.tickets.set(token, t);
    return { ticket: token, trap, name, grounds: selected.scope.grounds, repo: selected.repo, worktree, request: t.request, expiresAt: new Date(until).toISOString() };
  }
  /** Reserve the configured profile's durable plain-folder slot without preparing a repo. */
  private configuredTicket(grounds: unknown, name: string, request: string, cwd: string | undefined, until: number): BrokerTicket {
    const config = this.options.config(), scope = backendScope(config, id(grounds)), profile = config.traps?.[id(name)];
    if (scope.kind !== 'wharf' || !profile || profile.grounds !== scope.grounds) throw new Error('configured profile is not served by this boat and grounds');
    if (this.tickets.size >= 256 || this.sessions.size >= 256 || until <= this.now()) throw new Error('boat broker capacity reached or ticket expired');
    return withConfiguredTrapSlot(name, profile, undefined, (slot) => {
      const token = secret(), label = reserveTrapName(slot.trapId);
      const ticket: Ticket = { token, scope, configured: { profile: name, grounds: profile.grounds, surface: profile.surface }, trap: slot.trapId, name: label, request: id(request), until, used: false, worktree: slot.cwd, ...(cwd ? { origin: cwd } : {}) };
      this.tickets.set(token, ticket);
      return { ticket: token, trap: ticket.trap, name: label, grounds: scope.grounds, configured: ticket.configured, worktree: slot.cwd, request, expiresAt: new Date(until).toISOString() };
    });
  }

  async signOn(body: Record<string, unknown>): Promise<BrokerAgent> {
    const t = this.tickets.get(id(body.ticket));
    if (!t || t.used || t.until <= this.now()) throw new Error('trap ticket is expired, consumed or unknown');
    if (body.trap !== t.trap || body.repo !== t.repo || body.request !== t.request || body.grounds !== t.scope.grounds) throw new Error('trap ticket binding mismatch');
    if (t.configured) {
      const profile = this.options.config().traps?.[t.configured.profile];
      if (!profile || profile.grounds !== t.scope.grounds || profile.surface !== t.configured.surface) throw new Error('configured profile changed; request a new sign-on');
    } else this.scope(t.scope.grounds, t.repo);
    const session = id(body.session), pid = Number(body.pid);
    if (!Number.isSafeInteger(pid) || pid < 1 || !this.alive(pid)) throw new Error('trap session process is gone');
    const ownershipKey = t.configured ? t.trap : t.worktree;
    if (this.signingOn.has(ownershipKey) || [...this.sessions.values()].some((s) => this.live(s) && (t.configured && s.agent.configured ? trapBySession(s.agent.session)?.trapId === t.trap : s.agent.worktree === t.worktree))) throw new Error('another hosted trap is live in this worktree');
    t.used = true; // Consume before the await: concurrent sign-ons cannot both win.
    const cfg = this.options.config(), profile = t.configured ? { harness: cfg.traps![t.configured.profile]!.harness } : freshProfile(cfg, t.repo!);
    const harness = body.harness ?? profile.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('unknown trap harness');
    this.signingOn.add(ownershipKey);
    try {
      if (t.configured) {
        const configured = cfg.traps![t.configured.profile]!;
        if (harness !== configured.harness || (configured.surface === 'claude-desktop') !== (body.entrypoint === 'claude-desktop')) throw new Error('configured session harness or surface does not match its profile');
        withConfiguredTrapSlot(t.configured.profile, configured, session, (slot) => {
          if (slot.trapId !== t.trap) throw new Error('configured slot was adopted by another session');
          const signed = signOnTrap({ worktree: slot.cwd, cwd: slot.cwd, configured: t.configured, trapId: slot.trapId, harness, sessionId: session, ttlMs: cfg.soak.ttlSecs * 1000, window: { entrypoint: String(body.entrypoint ?? 'cli') }, ...(typeof body.link === 'string' ? { link: body.link } : {}) });
          if ('held' in signed) throw new Error('another session owns this configured slot');
        });
      }
      await this.remote(t.scope, t.name).request('workers/sign-on', { worker: t.name, ...(t.configured ? { target: { kind: 'configured-trap', ...t.configured } } : { repo: t.repo, repoRemote: this.options.identity!(t.repo!) }), harness, session,
        ...(typeof body.tmuxPane === 'string' && /^%[0-9]+$/.test(body.tmuxPane) ? { tmuxPane: body.tmuxPane } : {}) }, randomUUID());
      if (!this.alive(pid)) throw new Error('trap session process is gone');
      const agent: BrokerAgent = { grounds: t.scope.grounds, ...(t.configured ? { configured: t.configured } : { repo: t.repo }), trap: t.name, session, capability: secret(), worktree: t.worktree, ...(t.origin ? { origin: t.origin } : {}) };
      this.sessions.set(agent.capability, { agent, scope: t.scope, name: t.name, pid, seen: this.now(), current: null, reported: false, tail: Promise.resolve() });
      return agent;
    } catch (error) { if (t.configured && readTrap(t.trap)?.sessionId === session) stowTrap(t.trap, 'hosted sign-on failed'); throw error; } finally { this.signingOn.delete(ownershipKey); }
  }
  private session(body: Record<string, unknown>): Session {
    const s = this.sessions.get(id(body.capability));
    if (!s || s.agent.session !== body.session || s.agent.grounds !== body.grounds || !this.alive(s.pid)) throw new Error('trap session is gone or its broker capability is unknown');
    return s;
  }
  private serial<T>(s: Session, work: () => Promise<T>): Promise<T> {
    const result = s.tail.catch(() => {}).then(work); s.tail = result; return result;
  }
  private live(s: Session) { return this.sessions.get(s.agent.capability) === s && this.alive(s.pid) && this.now() - s.seen < BROKER_LIVENESS_MS; }
  private async renew(s: Session) {
    if (!this.live(s)) throw new Error('trap session is gone');
    if (s.current) {
      const validate = this.options.validateClaim ?? ((scope: Scope, claim: ClaimReceipt) => new WharfBackend(scope.location, claim.token!).heartbeat(claim.dispatch.id, randomUUID()));
      try { await validate(s.scope, s.current); }
      catch (e) {
        if (!(e instanceof BackendError) || ![401, 403, 409].includes(e.status)) throw e;
        s.current = null; s.reported = false; // Never hand a stale epoch back to the session.
      }
    }
    const registration = s.agent.configured ? trapBySession(s.agent.session) : undefined;
    if (registration) { heartbeatTrap(registration.trapId); if (s.current && registration.hostedCatch) renewDesktopLease(registration); }
    if (this.live(s)) await this.remote(s.scope, s.agent.trap).request('workers/renew', { worker: s.agent.trap }, randomUUID());
  }
  async handle(route: string, body: Record<string, unknown>): Promise<unknown> {
    if (route === 'ticket') return this.ticket(body.grounds, body.repo, randomUUID(), typeof body.cwd === 'string' ? body.cwd : undefined, undefined, typeof body.profile === 'string' ? body.profile : undefined);
    if (route === 'sign-on') return this.signOn(body);
    if (route === 'launch') {
      const t = await this.ticket(body.grounds, body.repo);
      if (Date.parse(t.expiresAt) <= this.now()) throw new Error('start request expired');
      if (!t.repo) throw new Error('configured surfaces start with man throw trap:<profile>');
      await this.options.launch!({ ...t, repo: t.repo, grounds: t.grounds }); return { trap: t.trap, name: t.name, worktree: t.worktree };
    }
    if (!['poll', 'heartbeat', 'progress', 'finish', 'end'].includes(route)) throw new Error('broker action not available');
    const s = this.session(body);
    if (route === 'end') { this.sessions.delete(s.agent.capability); if (s.agent.configured) stowTrap(trapBySession(s.agent.session)?.trapId ?? '', 'hosted session signed off'); return { stopped: true }; }
    s.seen = this.now();
    return this.serial(s, async () => {
      if (!this.live(s)) throw new Error('trap session is gone');
      if (route === 'finish') {
        if (s.current?.dispatch.id === body.dispatch) { s.current = null; s.reported = false; const registration = trapBySession(s.agent.session); if (s.agent.configured && registration) { releaseDesktopLease(registration.trapId); heartbeatTrap(registration.trapId, { claimed: null, hostedCatch: null }); } }
        return { finished: true };
      }
      if (route === 'progress') {
        const registration = s.agent.configured ? trapBySession(s.agent.session) : undefined;
        if (registration && body.verb === 'working' && !acquireDesktopLease(registration)) throw new Error('another desk owns the host UI; retry when it finishes');
        if (registration && ['paused', 'needs-decision', 'blocked'].includes(String(body.verb))) { releaseDesktopLease(registration.trapId); heartbeatTrap(registration.trapId, { hostedCatch: null }); }
        if (registration && body.verb === 'working') heartbeatTrap(registration.trapId, { hostedCatch: String(body.dispatch) });
        if (s.current?.dispatch.id === body.dispatch) s.reported = true; return { recorded: true };
      }
      const backend = this.remote(s.scope, s.agent.trap);
      await this.renew(s);
      const registration = s.agent.configured ? trapBySession(s.agent.session) : undefined;
      if (registration && route === 'poll') heartbeatTrap(registration.trapId, { parked: true });
      if (route === 'poll' && !s.current && this.live(s) && (!registration || acquireDesktopLease(registration))) {
        s.current = await backend.claim(randomUUID());
        if (registration) { if (s.current) heartbeatTrap(registration.trapId, { claimed: s.current.dispatch.id, hostedCatch: s.current.dispatch.id }); else releaseDesktopLease(registration.trapId); }
      }
      if (route === 'poll' && s.current && s.reported) {
        const inbox = this.options.inbox ?? ((scope: Scope, claim: ClaimReceipt) => new WharfBackend(scope.location, claim.token!).messages(claim.dispatch.id));
        return { claim: null, dispatch: s.current.dispatch.id, messages: (await inbox(s.scope, s.current)).filter((m) => !m.received) };
      }
      return { claim: s.current };
    });
  }
  /** Existing daemon cadence only; a vanished session receives no further renewals. */
  async poll(): Promise<void> {
    const cfg = this.options.config();
    for (const [key, t] of this.tickets) if (t.until <= this.now()) this.tickets.delete(key);
    for (const [key, s] of this.sessions) if (!this.alive(s.pid)) { this.sessions.delete(key); const registration = s.agent.configured ? trapBySession(s.agent.session) : undefined; if (registration) stowTrap(registration.trapId, 'hosted session process ended'); }
    await Promise.all([...this.sessions.values()].filter((s) => this.live(s)).map((s) => this.serial(s, async () => {
      if (this.live(s)) await this.renew(s);
    }).catch(() => {})));
    if (!cfg.soak.acceptWharfStarts) return;
    for (const scope of backendScopes(cfg)) {
      if (scope.kind !== 'wharf') continue;
      const backend = this.remote(scope);
      const requests = await backend.request('requests/starts') as Array<{ id: string; repo: string; expiresAt: string }>;
      for (const r of requests) {
        if (this.starts.has(r.id) || !Number.isFinite(Date.parse(r.expiresAt)) || Date.parse(r.expiresAt) <= this.now()) continue;
        this.starts.add(r.id);
        try {
          const repo = scope.repos.find((key) => { try { return this.options.identity!(key) === r.repo; } catch { return false; } });
          if (!repo) {
            await backend.request(`requests/${id(r.id)}/start`, { refused: 'repo is not configured on this boat' }, `refuse-${r.id}`); continue;
          }
          const t = await this.ticket(scope.grounds, repo, r.id, undefined, Date.parse(r.expiresAt));
          await backend.request(`requests/${id(r.id)}/start`, {}, `start-${r.id}`);
          if (Date.parse(t.expiresAt) <= this.now()) throw new Error('start request expired before launch');
          if (!t.repo) throw new Error('configured surfaces cannot launch from a wharf repo-start request');
          await this.options.launch!({ ...t, repo: t.repo, grounds: scope.grounds });
        } finally { this.starts.delete(r.id); }
      }
    }
  }
}

/** One bounded loopback interface for every hosted trap; never a credential proxy. */
export async function startWharfBroker(options: BrokerOptions) {
  const broker = new WharfTrapBroker(options), nonce = secret();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method !== 'POST' || req.headers.origin || req.headers['x-lobstah-broker'] !== nonce || req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) throw new Error('local broker request refused');
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw new Error('broker request too large'); }
      const body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid broker body');
      res.end(JSON.stringify(await broker.handle((req.url ?? '').slice(1), body)));
    } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'broker refused' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const file = brokerAddressFile(), tmp = uniqueTempPath(file), address = { pid: process.pid, port: (server.address() as { port: number }).port, nonce };
  fs.writeFileSync(tmp, JSON.stringify(address), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file);
  return { broker, close: async () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === nonce) fs.rmSync(file, { force: true }); } catch { /* replaced or removed */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

export function daemonBrokerOptions(config: () => Config): BrokerOptions {
  return { config, identity: (repo) => wharfRepoIdentity(config(), repo),
    async prepare(repo, trap, request, cwd) {
      const cfg = config(), site = cwd ? inspectSoakSite(cwd, cfg.repos) : undefined;
      if (cwd && (!site || site.repoKey !== repo)) throw new Error('soak directory is not the configured repo');
      if (site && !site.primary) return site.worktree;
      return (await createSoakWorktree({ repoKey: repo, repo: cfg.repos[repo]!, trapId: trap, sessionId: `wharf-${request}`, minFreeGB: cfg.limits.minFreeGB })).dir;
    },
    async launch(t) {
      const cfg = config(), profile = freshProfile(cfg, t.repo);
      const command = harnessCommand({ ...profile, cwd: t.worktree, ticket: t.ticket });
      command.argv = [process.execPath, fileURLToPath(new URL('./wharf-trap-runner.js', import.meta.url)), ...command.argv];
      for (const wharf of Object.values(cfg.wharves ?? {})) command.env[wharf.tokenEnv] = '';
      Object.assign(command.env, { LOBSTAH_GROUNDS: t.grounds, LOBSTAH_WHARF_AGENT: '1',
        LOBSTAH_WHARF_REPO: t.repo, LOBSTAH_WHARF_TRAP: t.trap, LOBSTAH_WHARF_REQUEST: t.request });
      const terminal = cfg.soak.terminal ?? 'terminal';
      await (terminal === 'tmux' ? tmuxTerminalAdapter(cfg) : macTerminalAdapter(terminal)).launch({ ...command, trap: t.trap, repo: t.repo });
    } };
}
