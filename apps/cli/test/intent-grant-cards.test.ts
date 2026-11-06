import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addGrant, answerDecision, enqueue, ensureLayout, GrantError, INTENT_ALWAYS_OPTION, INTENT_HOUR_OPTION, listGrants, parseIntentPattern, signOnTrap, claimBait, standingDecisions, unhandled } from '@lobstah/core';
import type { DecisionMeta, Grant, GrantIntent } from '@lobstah/core';
import { applyPermissionAnswer, askPermission, checkCall, permissionAnswerAllowed } from '../src/grants-cli.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { grantExpiryText } from '../../../packages/glass-ui/ui/components/session-grants.js';
import { loadGlass } from './glass-dom.js';
import { NOW, emptyFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
const DISPATCH = 'aaaaaaaa-1111-4aaa-8aaa-111111111111';
const INTENT: GrantIntent = {
  text: 'read-only diagnosis of Potluck production: logs and SELECT queries, no writes',
  patterns: [parseIntentPattern('scripts/with-timeout * npx wrangler tail')],
};
let home: string;
let worktree: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-intent-card-')));
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
  ensureLayout();
  worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = "${worktree.replace(/\\/g, '/')}"\ntrunk = "main"\n`);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'claude', sessionId: SESSION, name: 'pearl-gull', ttlMs: 3_600_000 });
  if (!('ok' in signed)) throw new Error('held');
  enqueue({ id: DISPATCH, repo: 'web', brief: 'Diagnose production', for: `wt:${signed.ok.trapId}` });
  claimBait(signed.ok);
});
afterEach(() => {
  removeTempDir(home);
  for (const key of ['LOBSTAH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete process.env[key];
});

const askCard = (intent?: GrantIntent): DecisionMeta =>
  askPermission({
    dispatch: DISPATCH,
    lane: 'work',
    repo: 'web',
    ask: { command: 'scripts/with-timeout 60 npx wrangler tail potluck', harness: 'claude', trap: 'pearl-gull', ...(intent ? { intent } : {}) },
  });
const answerWith = (card: DecisionMeta, option: string): Grant | undefined =>
  applyPermissionAnswer(card, { option, by: 'glass', at: new Date().toISOString() } as Parameters<typeof applyPermissionAnswer>[1]);
const bash = (command: string) => ({ harness: 'claude' as const, tool: 'Bash', input: { command }, session: SESSION });

describe('the permission card', () => {
  it('offers the kind of action beside Allow once when the trap proposes one', () => {
    const { options } = askCard(INTENT);
    expect(options).toEqual(['Allow once', INTENT_HOUR_OPTION, INTENT_ALWAYS_OPTION, 'No']);
  });

  it('offers only what it did with no proposal', () => {
    const { options } = askCard();
    expect(options).not.toContain(INTENT_HOUR_OPTION);
    expect(options).not.toContain(INTENT_ALWAYS_OPTION);
    expect(options.slice(0, 2)).toEqual(['Allow once', 'Allow always']);
  });

  it('shows the sentence and every pattern before anyone clicks', () => {
    const card = askCard({ ...INTENT, patterns: [...INTENT.patterns, parseIntentPattern('path:reports/')] });
    const detail = fs.readFileSync(path.join(home, 'decisions', card.key.replace('decision:', ''), 'detail.md'), 'utf8');
    expect(detail).toContain(INTENT.text);
    expect(detail).toContain('`scripts/with-timeout * npx wrangler tail`');
    expect(detail).toContain('`path:reports/`');
    expect(detail).toContain("Anything else goes to the harness's reviewer, as it would without a grant");
    expect(detail).toContain('for this trap only, for an hour');
    expect(detail).toContain('for every trap in web, until you revoke it');
  });

  it('leads with what is being approved, above the options', () => {
    const card = askCard(INTENT);
    const detail = fs.readFileSync(path.join(home, 'decisions', card.key.replace('decision:', ''), 'detail.md'), 'utf8');
    expect(detail.indexOf(INTENT.text)).toBeLessThan(detail.indexOf('**Allow once**'));
  });
});

describe('answering in the glass', () => {
  it('"for 1h" covers this trap only, for an hour', () => {
    const before = Date.now();
    const grant = answerWith(askCard(INTENT), INTENT_HOUR_OPTION)!;
    expect(grant).toMatchObject({ mode: 'intent', trap: 'pearl-gull', harness: 'any', by: 'glass', dispatch: DISPATCH, intent: INTENT });
    expect(grant.repo).toBeUndefined();
    const left = Date.parse(grant.expiresAt!) - before;
    expect(left).toBeGreaterThanOrEqual(3_600_000);
    expect(left).toBeLessThan(3_660_000);
  });

  it('"always" covers every trap in this repo, until revoked', () => {
    const grant = answerWith(askCard(INTENT), INTENT_ALWAYS_OPTION)!;
    expect(grant).toMatchObject({ mode: 'intent', repo: 'web', harness: 'any' });
    expect(grant.trap).toBeUndefined();
    expect(grant.expiresAt).toBeUndefined();
  });

  it('the scopes hold: another trap is not covered by 1h, and is by always', () => {
    const otherSession = '22222222-3333-4444-8555-666666666666';
    const otherWorktree = path.join(home, 'other');
    fs.mkdirSync(otherWorktree);
    const other = signOnTrap({ worktree: otherWorktree, cwd: otherWorktree, repo: 'web', harness: 'codex', sessionId: otherSession, name: 'early-pebble', ttlMs: 3_600_000 });
    expect('ok' in other).toBe(true);
    const otherCall = { harness: 'codex' as const, tool: 'exec_command', input: { cmd: 'scripts/with-timeout 90 npx wrangler tail other' }, session: otherSession };
    const hour = answerWith(askCard(INTENT), INTENT_HOUR_OPTION)!;
    expect(checkCall(bash('scripts/with-timeout 90 npx wrangler tail other'), worktree, true)).toEqual([hour.id]);
    expect(checkCall(otherCall, otherWorktree, true)).toBeUndefined();
    const always = answerWith(askCard(INTENT), INTENT_ALWAYS_OPTION)!;
    expect(checkCall(otherCall, otherWorktree, true)).toEqual([always.id]);
  });

  it('then a different command of that kind runs, with no new card', () => {
    const card = askCard(INTENT);
    const grant = answerWith(card, INTENT_HOUR_OPTION)!;
    expect(checkCall(bash('scripts/with-timeout 90 npx wrangler tail other --format json'), worktree, true)).toEqual([grant.id]);
    expect(checkCall(bash('npx wrangler deploy'), worktree, true)).toBeUndefined();
  });

  it('tells the trap what was approved and how far it goes', () => {
    const grant = answerWith(askCard(INTENT), INTENT_HOUR_OPTION)!;
    const messages = JSON.stringify(unhandled(DISPATCH, 'work'));
    expect(messages).toContain(grant.id);
    expect(messages).toContain('for this trap, for an hour');
    expect(messages).toContain('scripts/with-timeout * npx wrangler tail');
    expect(messages).toContain("Anything else goes to your harness's reviewer as usual");
  });

  it('Allow once still writes the grant it did, and Allow always is not offered beside the kinds', () => {
    expect(answerWith(askCard(INTENT), 'Allow once')).toMatchObject({ mode: 'once', match: 'exact' });
    const card = askCard(INTENT);
    expect(() => answerDecision({ key: card.key, option: 'Allow always', by: 'glass', maxBytes: 1024 })).toThrow(/not an option/);
    expect(answerWith(askCard(), 'Allow always')?.mode).toBe('always');
  });

  it('with no trap on the card, 1h covers the repo; with no repo, always covers the trap', () => {
    const noTrap = askPermission({ dispatch: DISPATCH, lane: 'work', repo: 'web', ask: { command: 'x y', harness: 'claude', intent: INTENT } });
    expect(answerWith(noTrap, INTENT_HOUR_OPTION)).toMatchObject({ repo: 'web' });
    const noRepo = askPermission({ dispatch: DISPATCH, lane: 'work', ask: { command: 'x y', harness: 'claude', trap: 'pearl-gull', intent: INTENT } });
    expect(answerWith(noRepo, INTENT_ALWAYS_OPTION)).toMatchObject({ trap: 'pearl-gull' });
  });
});

describe('only a person grants', () => {
  it.each(['Allow once', 'Allow always', INTENT_HOUR_OPTION, INTENT_ALWAYS_OPTION, 'Allow this tool family for 15 min'])('`man answer` cannot answer %s', (option) => {
    expect(() => permissionAnswerAllowed(askCard(INTENT), option, 'cli')).toThrow(GrantError);
  });

  it('`man answer` can still say No, and the glass can answer anything', () => {
    const card = askCard(INTENT);
    expect(() => permissionAnswerAllowed(card, 'No', 'cli')).not.toThrow();
    expect(() => permissionAnswerAllowed(card, INTENT_ALWAYS_OPTION, 'glass')).not.toThrow();
  });

  it('an answer that did not come from the glass writes no grant', () => {
    const card = askCard(INTENT);
    expect(applyPermissionAnswer(card, { option: INTENT_ALWAYS_OPTION, by: 'cli', at: new Date().toISOString() } as Parameters<typeof applyPermissionAnswer>[1])).toBeUndefined();
    expect(listGrants().grants).toEqual([]);
  });
});

describe('a trap proposes with lobstah report', () => {
  const report = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'report', DISPATCH, 'needs-decision', 'I need to read production logs', ...args], {
      encoding: 'utf8', timeout: 15_000, cwd: worktree, env: { ...process.env, LOBSTAH_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION },
    });
  const cards = () => fs.existsSync(path.join(home, 'decisions')) ? fs.readdirSync(path.join(home, 'decisions')).filter((name) => /^[0-9a-f]{8}$/.test(name)) : [];

  it('puts its proposal on the card', () => {
    const out = report('--ask', 'npx wrangler tail potluck', '--intent', 'read logs only', '--allow', 'npx wrangler tail', '--allow', 'path:reports/');
    expect(out.status, out.stderr).toBe(0);
    const meta = standingDecisions().find((decision) => decision.dispatch === DISPATCH)!;
    expect(meta.options).toContain(INTENT_HOUR_OPTION);
    expect(meta.permission?.intent).toEqual({ text: 'read logs only', patterns: [{ kind: 'command', pattern: 'npx wrangler tail' }, { kind: 'path', pattern: 'reports/' }] });
  });

  it.each([
    [['--ask', 'npx wrangler tail', '--intent', 'read logs', '--allow', 'git'], 'one word'],
    [['--ask', 'npx wrangler tail', '--intent', 'read logs', '--allow', 'bash -c'], 'runs anything'],
    [['--ask', 'npx wrangler tail', '--intent', 'read logs', '--allow', 'lobstah grant x'], 'its own permissions'],
    [['--ask', 'npx wrangler tail', '--allow', 'npx wrangler tail'], 'go together'],
    [['--ask', 'npx wrangler tail', '--intent', 'read logs'], 'go together'],
    [['--intent', 'read logs', '--allow', 'npx wrangler tail'], 'go with --ask'],
  ])('refuses %j, and files no card', (args, reason) => {
    const out = report(...args);
    expect(out.status).not.toBe(0);
    expect(out.stderr + out.stdout).toContain(reason);
    expect(cards()).toEqual([]);
  });
});

describe('the Grants tab', () => {
  const standing = (extra: Partial<Grant>): Grant => ({
    id: 'g-1a2b3c4d', at: new Date(NOW).toISOString(), by: 'glass', harness: 'claude', mode: 'intent', uses: 3, trap: 'pearl-gull', intent: INTENT,
    lastUsedAt: new Date(NOW - 60_000).toISOString(), ...extra,
  });
  const open = (grants: Grant[], post?: Parameters<typeof loadGlass>[2]['post']) => {
    const fleet = emptyFleet();
    fleet.focusToken = 'tok';
    fleet.standingGrants = grants;
    return loadGlass(GLASS_PAGE, fleet, { now: NOW, hash: '#grants', ...(post ? { post } : {}) });
  };

  it('lists an intent grant with its scope, patterns, expiry and use', async () => {
    const g = await open([standing({ expiresAt: new Date(NOW + 30 * 60_000).toISOString() })]);
    try {
      const card = g.$('.standing-grant')!;
      expect(card.textContent).toContain(INTENT.text);
      expect(card.textContent).toContain('Trap pearl-gull');
      expect(card.textContent).toContain('Claude Code');
      expect(card.textContent).toContain('scripts/with-timeout * npx wrangler tail');
      expect(card.textContent).toContain('3 uses');
      expect(card.textContent).toContain('last used');
      expect(card.textContent).toContain('g-1a2b3c4d');
    } finally {
      await g.close();
    }
  });

  it('lists command and path grants too, and an always grant as covering its repo', async () => {
    const g = await open([
      standing({ id: 'g-1', mode: 'always', intent: undefined, trap: undefined, command: 'npx wrangler tail', match: 'prefix', harness: 'any' }),
      standing({ id: 'g-2', mode: 'always', intent: undefined, trap: undefined, path: '/w/reports/', harness: 'any' }),
      standing({ id: 'g-3', trap: undefined, repo: 'web', harness: 'any' }),
    ]);
    try {
      const text = g.$$('.standing-grant').map((card) => card.textContent ?? '');
      expect(text[0]).toContain('npx wrangler tail …');
      expect(text[0]).toContain('Every trap');
      expect(text[1]).toContain('Write /w/reports/');
      expect(text[2]).toContain('Every trap in web');
    } finally {
      await g.close();
    }
  });

  it('Revoke asks for exactly that grant', async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const g = await open([standing({})], async (url, req) => {
      posts.push({ url, body: req.body });
      return { status: 200, body: { ok: true } };
    });
    try {
      (g.$('.standing-grant button') as HTMLElement).click();
      await g.settle();
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0]!.body)).toMatchObject({ kind: 'grant-revoke', payload: { id: 'g-1a2b3c4d' } });
    } finally {
      await g.close();
    }
  });

  it('with nothing in force, says so', async () => {
    const g = await open([]);
    try {
      expect(g.$('.session-grants')?.textContent).toContain('No active grants');
    } finally {
      await g.close();
    }
  });

  it('says how long a grant has left', () => {
    expect(grantExpiryText(undefined, NOW)).toBe('Until revoked');
    expect(grantExpiryText(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe('Expires in 30 min');
    expect(grantExpiryText(new Date(NOW + 5 * 3_600_000).toISOString(), NOW)).toBe('Expires in 5 h');
    expect(grantExpiryText(new Date(NOW - 1000).toISOString(), NOW)).toBe('Expired');
  });
});

it('a grant written by addGrant reads back through checkCall on the asking trap alone', () => {
  addGrant({ mode: 'intent', by: 'glass', harness: 'claude', trap: 'someone-else', intent: INTENT });
  expect(checkCall(bash('scripts/with-timeout 60 npx wrangler tail'), worktree, true)).toBeUndefined();
});
