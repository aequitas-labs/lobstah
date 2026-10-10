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
import { freshProfile, harnessCommand, macTerminalAdapter } from './throw.js';

type Scope = Extract<BackendScope, { kind: 'wharf' }>;
type Remote = Pick<WharfBackend, 'request' | 'claim'>;
type Ticket = { token: string; scope: Scope; repo: string; trap: string; name: string; request: string; until: number; used: boolean; worktree: string; origin?: string };
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
  async ticket(grounds: unknown, repo: unknown, request: string = randomUUID(), cwd?: string, until = this.now() + 180_000) {
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
  async signOn(body: Record<string, unknown>): Promise<BrokerAgent> {
    const t = this.tickets.get(id(body.ticket));
    if (!t || t.used || t.until <= this.now()) throw new Error('trap ticket is expired, consumed or unknown');
    if (body.trap !== t.trap || body.repo !== t.repo || body.request !== t.request || body.grounds !== t.scope.grounds) throw new Error('trap ticket binding mismatch');
    this.scope(t.scope.grounds, t.repo);
    const session = id(body.session), pid = Number(body.pid);
    if (!Number.isSafeInteger(pid) || pid < 1 || !this.alive(pid)) throw new Error('trap session process is gone');
    if (this.signingOn.has(t.worktree) || [...this.sessions.values()].some((s) => s.agent.worktree === t.worktree && this.live(s))) throw new Error('another hosted trap is live in this worktree');
    t.used = true; // Consume before the await: concurrent sign-ons cannot both win.
    const cfg = this.options.config(), profile = freshProfile(cfg, t.repo);
    const harness = body.harness ?? profile.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('unknown trap harness');
    this.signingOn.add(t.worktree);
    try {
      await this.remote(t.scope, t.name).request('workers/sign-on', { worker: t.name, repo: t.repo,
        repoRemote: this.options.identity!(t.repo), harness, session }, randomUUID());
      if (!this.alive(pid)) throw new Error('trap session process is gone');
      const agent: BrokerAgent = { grounds: t.scope.grounds, repo: t.repo, trap: t.name, session, capability: secret(), worktree: t.worktree, ...(t.origin ? { origin: t.origin } : {}) };
      this.sessions.set(agent.capability, { agent, scope: t.scope, name: t.name, pid, seen: this.now(), current: null, reported: false, tail: Promise.resolve() });
      return agent;
    } finally { this.signingOn.delete(t.worktree); }
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
    if (this.live(s)) await this.remote(s.scope, s.agent.trap).request('workers/renew', { worker: s.agent.trap }, randomUUID());
  }
  async handle(route: string, body: Record<string, unknown>): Promise<unknown> {
    if (route === 'ticket') return this.ticket(body.grounds, body.repo, randomUUID(), typeof body.cwd === 'string' ? body.cwd : undefined);
    if (route === 'sign-on') return this.signOn(body);
    if (route === 'launch') {
      const t = await this.ticket(body.grounds, body.repo);
      if (Date.parse(t.expiresAt) <= this.now()) throw new Error('start request expired');
      await this.options.launch!({ ...t, grounds: t.grounds }); return { trap: t.trap, name: t.name, worktree: t.worktree };
    }
    if (!['poll', 'heartbeat', 'progress', 'finish', 'end'].includes(route)) throw new Error('broker action not available');
    const s = this.session(body);
    if (route === 'end') { this.sessions.delete(s.agent.capability); return { stopped: true }; }
    s.seen = this.now();
    return this.serial(s, async () => {
      if (!this.live(s)) throw new Error('trap session is gone');
      if (route === 'finish') {
        if (s.current?.dispatch.id === body.dispatch) { s.current = null; s.reported = false; }
        return { finished: true };
      }
      if (route === 'progress') { if (s.current?.dispatch.id === body.dispatch) s.reported = true; return { recorded: true }; }
      const backend = this.remote(s.scope, s.agent.trap);
      await this.renew(s);
      if (route === 'poll' && !s.current && this.live(s)) s.current = await backend.claim(randomUUID());
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
    for (const [key, s] of this.sessions) if (!this.alive(s.pid)) this.sessions.delete(key);
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
          await this.options.launch!({ ...t, grounds: scope.grounds });
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
      await macTerminalAdapter(cfg.soak.terminal ?? 'terminal').launch(command);
    } };
}
