import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, ensureLayout, mergeEvidence } from '../src/index.js';
import { configPath } from '../src/config.js';
import {
  TELEMETRY_ENDPOINT,
  TELEMETRY_FIELDS,
  TELEMETRY_NOTICE,
  TELEMETRY_MAX_TRAPS,
  buildTelemetryPayload,
  disableTelemetry,
  enableTelemetry,
  ensureTelemetryState,
  envOffSwitch,
  readTelemetryState,
  sendTelemetry,
  serializeTelemetryPayload,
  setTelemetryShare,
  telemetryCliRun,
  telemetryStatus,
} from '../src/telemetry.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { reserveTrapName } from '../src/trap-names.js';
import { statsPath } from '../src/stats.js';

const ENDPOINT = 'https://telemetry.example.test/v1/daily';
const DAY = 86_400_000;
const NOON = Date.parse('2026-10-06T12:00:00Z');
const CLEAN: NodeJS.ProcessEnv = {};

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-telemetry-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** A fleet with the things telemetry must never send: repos, traps, briefs, PRs, sessions. */
function fleet(): { secrets: string[] } {
  const repo = path.join(home, 'src', 'secret-repo-name');
  fs.writeFileSync(configPath(), `[repos.secret-repo-key]\npath = "${repo.replaceAll('\\', '\\\\')}"\n`);
  const secrets = ['secret-repo-name', 'secret-repo-key', 'kind-crab', 'wt:trapid99', 'dispatch-0001', 'github.com/acme', home];
  for (const id of ['dispatch-0001', 'dispatch-0002']) {
    mergeEvidence(id, 'work', { deliveredTo: 'wt:trapid99', deliveredAt: new Date().toISOString(), pr: 'https://github.com/acme/app/pull/7' } as never);
    appendStatus(id, 'work', 'done', 'finished secret-repo-name for kind-crab');
  }
  fs.mkdirSync(path.join(home, 'trap-names'), { recursive: true });
  fs.writeFileSync(path.join(home, 'trap-names', 'kind-crab.json'), JSON.stringify({ trapId: 'trapid99' }));
  // Host and user are only secrets when they are distinctive enough to find.
  for (const s of [os.hostname(), os.userInfo().username]) if (s.length >= 4) secrets.push(s);
  return { secrets };
}

/** A fetch that records each request. */
function recorder(status = 204) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(null, { status });
  });
  return { calls, fetch: fn as unknown as typeof fetch };
}

function consented(): void {
  telemetryCliRun({ interactive: true, write: () => {}, env: CLEAN, endpoint: ENDPOINT, now: NOON });
}

describe('telemetry payload', () => {
  it('serialises only the allowed keys, with nothing from the fleet in it', () => {
    const { secrets } = fleet();
    const state = ensureTelemetryState();
    const payload = buildTelemetryPayload(state.installId);
    // Even an object carrying extra keys serialises to the allowed ones only.
    const json = serializeTelemetryPayload({ ...payload, repo: 'secret-repo-name', hostname: os.hostname(), catches: { ...payload.catches, path: home } } as never);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const allowed = new Set<string>(TELEMETRY_FIELDS);
    const unexpected = Object.keys(parsed).filter((k) => !allowed.has(k));
    expect(unexpected, `payload carries keys outside the allowed list: ${unexpected.join(', ')}`).toEqual([]);
    expect(Object.keys(parsed)).toEqual([...TELEMETRY_FIELDS]);
    for (const s of secrets) expect(json, `payload leaks ${s}`).not.toContain(s);
    expect(parsed).toMatchObject({ schema: 1, catches: { today: 2, total: 2 }, traps: [] });
    expect(Object.keys(parsed.catches as object)).toEqual(['today', 'total']);
    expect(parsed.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(['macos', 'linux', 'windows', 'other']).toContain(parsed.os);
    expect(['x64', 'arm64', 'other']).toContain(parsed.arch);
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shares only proven generated names, with positive UTC-day catches; headless/custom/unknown stay in totals', () => {
    const generated = reserveTrapName('auto', undefined, 0);
    reserveTrapName('custom', 'kind-crab');
    fs.writeFileSync(path.join(home, 'trap-names', 'amber-gull.json'), JSON.stringify({ trapId: 'legacy' }));
    fs.writeFileSync(statsPath(), JSON.stringify({ version: 1, totalCatches: 99, perTrap: {}, day: '2026-10-05', catchesToday: 77, counted: [], utc: { date: '2026-10-06', catches: 10, perTrap: { 'wt:auto': 2, 'wt:custom': 3, 'wt:legacy': 1 } } }));
    const p = buildTelemetryPayload(ensureTelemetryState().installId, NOON);
    expect(p.catches).toEqual({ today: 10, total: 99 });
    expect(p.traps).toEqual([{ name: generated, today: 2 }]);
    expect(buildTelemetryPayload(p.installId, NOON + DAY)).toMatchObject({ catches: { today: 0, total: 99 }, traps: [] });
  });

  it('bounds names on the client, strips nested extras, and caps the highest-count table at 100', () => {
    const perTrap: Record<string, number> = {};
    for (let i = 0; i < 105; i++) {
      reserveTrapName(String(i), undefined, i);
      perTrap[`wt:${i}`] = i + 1;
    }
    fs.writeFileSync(statsPath(), JSON.stringify({ version: 1, totalCatches: 6000, perTrap, day: '2026-10-06', catchesToday: 6000, counted: [], utc: { date: '2026-10-06', catches: 6000, perTrap } }));
    const p = buildTelemetryPayload(ensureTelemetryState().installId, NOON);
    expect(p.traps).toHaveLength(TELEMETRY_MAX_TRAPS);
    expect(p.traps[0]?.today).toBe(105);
    expect(p.traps.at(-1)?.today).toBe(6);
    const invalid = ['x-crab', 'toolonggg-crab', 'Amber-crab', 'amber/../crab', 'amber-crab\n', 'secret repo'];
    const traps = invalid.map((name) => ({ name, today: 1 })).concat([{ name: p.traps[0]!.name, today: 0 }], p.traps.map((t) => ({ ...t, secret: home })));
    const json = serializeTelemetryPayload({ ...p, traps });
    expect(JSON.parse(json).traps).toEqual(p.traps);
    expect(json).not.toContain(home);
    expect(json).not.toContain('secret');
    expect(Buffer.byteLength(json)).toBeLessThan(8192);
  });

  it('notice explains name provenance, omitted catches and no hashing', () => {
    expect(TELEMETRY_NOTICE).toContain('up to 100 automatically');
    expect(TELEMETRY_NOTICE).toContain('Custom names (--name) and older names with unknown provenance stay local');
    expect(TELEMETRY_NOTICE).toContain('Names are not hashed');
  });

  it('keeps one random install id, stored under the home', () => {
    const a = ensureTelemetryState().installId;
    expect(ensureTelemetryState().installId).toBe(a);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'telemetry.json'), 'utf8')).installId).toBe(a);
  });

  it('ships with an empty endpoint: this build sends nothing', async () => {
    expect(TELEMETRY_ENDPOINT).toBe('');
    consented();
    const r = recorder();
    expect(await sendTelemetry({ env: CLEAN, fetch: r.fetch })).toBe('no-endpoint');
    expect(r.calls).toHaveLength(0);
  });
});

describe('telemetry sending', () => {
  it('sends nothing before the notice has been shown on an interactive run', async () => {
    const r = recorder();
    telemetryCliRun({ interactive: false, write: () => {}, env: CLEAN, endpoint: ENDPOINT });
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON })).toBe('no-notice');
    expect(r.calls).toHaveLength(0);
  });

  it('shows the notice once, then sends the exact show payload once per UTC day', async () => {
    fleet();
    const out: string[] = [];
    const run = () => telemetryCliRun({ interactive: true, write: (t) => out.push(t), env: CLEAN, endpoint: ENDPOINT, now: NOON });
    expect(run()).toBe(TELEMETRY_NOTICE);
    expect(run()).toBeUndefined();
    expect(out).toEqual([`${TELEMETRY_NOTICE}\n`]);

    const r = recorder();
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON })).toBe('sent');
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON + 3_600_000 })).toBe('already-sent');
    expect(r.calls).toHaveLength(1);
    const { url, init } = r.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(serializeTelemetryPayload(buildTelemetryPayload(readTelemetryState()!.installId, NOON)));
    expect(JSON.parse(init.body as string).date).toBe('2026-10-06');

    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON + DAY })).toBe('sent');
    expect(JSON.parse(r.calls[1]!.init.body as string).date).toBe('2026-10-07');
  });

  it.each([
    ['config', {}, true],
    ['LOBSTAH_TELEMETRY=0', { LOBSTAH_TELEMETRY: '0' }, false],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }, false],
    ['CI set', { CI: 'true' }, false],
  ] as const)('any one switch turns it off: %s', async (_name, env, config) => {
    consented();
    if (config) disableTelemetry();
    const r = recorder();
    expect(telemetryStatus(env, ENDPOINT).sharing).toBe(false);
    expect(await sendTelemetry({ env, endpoint: ENDPOINT, fetch: r.fetch, now: NOON })).toBe('off');
    expect(r.calls).toHaveLength(0);
  });

  it('does not show the notice when sharing is off', () => {
    disableTelemetry();
    const out: string[] = [];
    expect(telemetryCliRun({ interactive: true, write: (t) => out.push(t), env: CLEAN, endpoint: ENDPOINT })).toBeUndefined();
    expect(telemetryCliRun({ interactive: true, write: (t) => out.push(t), env: { DO_NOT_TRACK: '1' }, endpoint: ENDPOINT })).toBeUndefined();
    expect(out).toEqual([]);
  });

  it('a CLI run that sees an env switch turns the daemon off until an interactive run without one', async () => {
    consented();
    // A hook or an agent's shell carries the user's DO_NOT_TRACK; the daemon (a service) does not.
    telemetryCliRun({ interactive: false, write: () => {}, env: { DO_NOT_TRACK: '1' }, endpoint: ENDPOINT });
    const r = recorder();
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON })).toBe('off');
    expect(telemetryStatus(CLEAN, ENDPOINT).offBy.join()).toContain('DO_NOT_TRACK');
    // A non-interactive run without it does not clear it; an interactive one does.
    telemetryCliRun({ interactive: false, write: () => {}, env: CLEAN, endpoint: ENDPOINT });
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON })).toBe('off');
    telemetryCliRun({ interactive: true, write: () => {}, env: CLEAN, endpoint: ENDPOINT });
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: r.fetch, now: NOON })).toBe('sent');
  });

  it('is silent and bounded on network failure, and does not retry that day', async () => {
    consented();
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: failing, now: NOON })).toBe('error');
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: failing, now: NOON })).toBe('already-sent');

    // A server that never answers: the timeout ends the attempt.
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    expect(await sendTelemetry({ env: CLEAN, endpoint: ENDPOINT, fetch: hanging, now: NOON + DAY, timeoutMs: 50 })).toBe('error');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('telemetry switches', () => {
  it('reads each environment switch', () => {
    expect(envOffSwitch({})).toBeUndefined();
    expect(envOffSwitch({ LOBSTAH_TELEMETRY: '1' })).toBeUndefined();
    expect(envOffSwitch({ DO_NOT_TRACK: '0' })).toBeUndefined();
    expect(envOffSwitch({ LOBSTAH_TELEMETRY: '0' })).toBe('LOBSTAH_TELEMETRY');
    expect(envOffSwitch({ LOBSTAH_TELEMETRY: 'off' })).toBe('LOBSTAH_TELEMETRY');
    expect(envOffSwitch({ DO_NOT_TRACK: '1' })).toBe('DO_NOT_TRACK');
    expect(envOffSwitch({ CI: '' })).toBe('CI');
  });

  it('enable and disable edit [telemetry] share and keep the rest of the config', () => {
    const before = '# my config\n[repos.app]\npath = "/x"\n\n[telemetry]\n# keep me\nshare = true\n\n[limits]\nmaxConcurrent = 2\n';
    fs.writeFileSync(configPath(), before);
    disableTelemetry();
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before.replace('share = true', 'share = false'));
    enableTelemetry(NOON);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
    expect(readTelemetryState()?.noticeShownAt).toBe(new Date(NOON).toISOString());
  });

  it('adds a [telemetry] table when there is none', () => {
    fs.writeFileSync(configPath(), '[limits]\nmaxConcurrent = 2');
    setTelemetryShare(false);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe('[limits]\nmaxConcurrent = 2\n\n[telemetry]\nshare = false\n');
    expect(telemetryStatus(CLEAN).sharing).toBe(false);
  });

  it('an unreadable config or a non-boolean share counts as off', () => {
    fs.writeFileSync(configPath(), '[telemetry]\nshare = "yes"\n');
    expect(telemetryStatus(CLEAN).sharing).toBe(false);
    fs.writeFileSync(configPath(), 'this is not toml [');
    expect(telemetryStatus(CLEAN).sharing).toBe(false);
  });
});
