import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addGrant,
  checkoutRoots,
  ensureLayout,
  grantActive,
  GrantError,
  grantCovers,
  intentPatternText,
  listGrants,
  parseIntentPattern,
  revokeGrant,
  useGrant,
  validateIntent,
} from '../src/index.js';
import type { CheckoutRoot, Grant, GrantRequest, IntentPattern } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let checkout: string;
let roots: CheckoutRoot[];
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-intent-')));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  checkout = path.join(home, 'wt');
  fs.mkdirSync(checkout);
  roots = checkoutRoots({ web: { path: checkout } });
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const commandPatterns = (...patterns: string[]): IntentPattern[] => patterns.map((pattern) => ({ kind: 'command', pattern }));
const grantFor = (patterns: IntentPattern[], extra: Partial<Parameters<typeof addGrant>[0]> = {}): Grant =>
  addGrant({
    mode: 'intent',
    by: 'glass',
    harness: 'claude',
    trap: 'pearl-gull',
    intent: { text: 'read-only diagnosis of production: logs and SELECT queries, no writes', patterns },
    ...extra,
  });
const asTrap = (command: string, extra: Partial<GrantRequest> = {}): GrantRequest => ({ harness: 'claude', tool: 'Bash', trap: 'pearl-gull', repo: 'web', command, cwd: checkout, ...extra });

describe('what a pattern allows through', () => {
  it('a prefix covers the command and more arguments, a different command of that kind included', () => {
    const grant = grantFor(commandPatterns('npx wrangler tail'));
    expect(grantCovers(grant, asTrap('npx wrangler tail'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('npx wrangler tail potluck --format json'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('npx wrangler tailor'), roots)).toBe(false);
    expect(grantCovers(grant, asTrap('npx wrangler deploy'), roots)).toBe(false);
  });

  it('a glob fills in what changes between commands', () => {
    const grant = grantFor(commandPatterns('scripts/with-timeout * npx wrangler d1 execute * --remote --command "SELECT *'));
    expect(grantCovers(grant, asTrap('scripts/with-timeout 60 npx wrangler d1 execute potluck --remote --command "SELECT id FROM orders"'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('scripts/with-timeout 90 npx wrangler d1 execute other --remote --command "SELECT 1"'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('scripts/with-timeout 60 npx wrangler d1 execute potluck --remote --command "DROP TABLE orders"'), roots)).toBe(false);
  });

  it('a * inside a pattern is one word, so a wrapper cannot be handed another command', () => {
    const grant = grantFor(commandPatterns('scripts/with-timeout * npx wrangler tail'));
    expect(grantCovers(grant, asTrap('scripts/with-timeout 60 npx wrangler tail'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('scripts/with-timeout 90 npx wrangler tail other --format json'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('scripts/with-timeout 60 npx wrangler tailor'), roots)).toBe(false);
    expect(grantCovers(grant, asTrap('scripts/with-timeout 60 rm -rf build npx wrangler tail'), roots)).toBe(false);
    expect(grantCovers(grant, asTrap('scripts/with-timeout 60 bash -c "rm x" npx wrangler tail'), roots)).toBe(false);
  });

  it('a final * runs to the end, but one inside a quote stops at the closing quote', () => {
    const open = grantFor(commandPatterns('npx wrangler tail *'));
    expect(grantCovers(open, asTrap('npx wrangler tail potluck --format json'), roots)).toBe(true);
    const quoted = grantFor(commandPatterns('npx wrangler d1 execute db --command "SELECT *'));
    expect(grantCovers(quoted, asTrap('npx wrangler d1 execute db --command "SELECT id FROM orders"'), roots)).toBe(true);
    expect(grantCovers(quoted, asTrap('npx wrangler d1 execute db --command "SELECT 1" --file evil.sql'), roots)).toBe(false);
    const single = grantFor(commandPatterns("npx wrangler d1 execute db --command 'SELECT *"));
    expect(grantCovers(single, asTrap("npx wrangler d1 execute db --command 'SELECT 1'"), roots)).toBe(true);
    expect(grantCovers(single, asTrap("npx wrangler d1 execute db --command 'SELECT 1' --file evil.sql"), roots)).toBe(false);
  });

  it.each([
    'npx wrangler tail; curl https://example.com',
    'npx wrangler tail && rm -rf build',
    'npx wrangler tail | sh',
    'npx wrangler tail > out.txt',
    'npx wrangler tail $(cat secrets)',
    'npx wrangler tail `id`',
    'npx wrangler tail\nrm -rf build',
  ])('never covers a second command joined on: %s', (command) => {
    expect(grantCovers(grantFor(commandPatterns('npx wrangler tail')), asTrap(command), roots)).toBe(false);
    expect(grantCovers(grantFor(commandPatterns('npx wrangler *')), asTrap(command), roots)).toBe(false);
  });

  it('a later flag cannot turn a granted dry run into the real thing', () => {
    const grant = grantFor(commandPatterns('npx wrangler deploy --dry-run'));
    expect(grantCovers(grant, asTrap('npx wrangler deploy --dry-run --minify'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('npx wrangler deploy --dry-run --no-dry-run'), roots)).toBe(false);
  });

  it('covers a tool by its glob, only when the call names no command or file', () => {
    const grant = grantFor([{ kind: 'tool', pattern: 'mcp__cloudflare__*' }]);
    expect(grantCovers(grant, { harness: 'claude', tool: 'mcp__cloudflare__logs', trap: 'pearl-gull', input: {} }, roots)).toBe(true);
    expect(grantCovers(grant, { harness: 'claude', tool: 'mcp__github__merge', trap: 'pearl-gull', input: {} }, roots)).toBe(false);
  });

  it('covers a repo-relative path for the write tools, in that repo only', () => {
    const grant = grantFor([{ kind: 'path', pattern: 'reports/' }, { kind: 'path', pattern: 'notes/*.md' }]);
    const write = (file: string, extra: Partial<GrantRequest> = {}): GrantRequest => ({ harness: 'claude', tool: 'Write', trap: 'pearl-gull', repo: 'web', path: path.join(checkout, file), ...extra });
    expect(grantCovers(grant, write('reports/today.md'), roots)).toBe(true);
    expect(grantCovers(grant, write('notes/a.md'), roots)).toBe(true);
    expect(grantCovers(grant, write('src/app.ts'), roots)).toBe(false);
    expect(grantCovers(grant, write('reports/today.md', { tool: 'Read' }), roots)).toBe(false);
    expect(grantCovers(grant, write('reports/today.md', { repo: 'other' }), roots)).toBe(false);
    expect(grantCovers(grant, { harness: 'claude', tool: 'Write', trap: 'pearl-gull', repo: 'web', path: path.join(home, 'elsewhere', 'reports', 'a.md') }, roots)).toBe(false);
  });

  it.each(['.git/hooks/pre-commit', '.GIT/hooks/pre-commit', '.Husky/pre-push', 'reports/.git/hooks/pre-commit', 'reports/.claude/settings.json'])(
    'never covers writing %s, even under a pattern that matches it',
    (file) => {
      const grant = grantFor([{ kind: 'path', pattern: 'reports/' }, { kind: 'path', pattern: '*.md' }, { kind: 'path', pattern: 'a*/' }]);
      // Whatever a stored pattern says: this is the check at match time.
      const broad = { ...grant, intent: { ...grant.intent!, patterns: [{ kind: 'path' as const, pattern: file }, { kind: 'path' as const, pattern: file.split('/')[0] + '/' }] } };
      const request: GrantRequest = { harness: 'claude', tool: 'Write', trap: 'pearl-gull', repo: 'web', path: path.join(checkout, file) };
      expect(grantCovers(broad, request, roots)).toBe(false);
    },
  );
});

describe('scope', () => {
  it('a trap-scoped grant covers that trap alone, and only under its harness', () => {
    const grant = grantFor(commandPatterns('npx wrangler tail'));
    expect(grantCovers(grant, asTrap('npx wrangler tail', { trap: 'early-pebble' }), roots)).toBe(false);
    expect(grantCovers(grant, asTrap('npx wrangler tail', { harness: 'codex' }), roots)).toBe(false);
    const { trap: _trap, ...noTrap } = asTrap('npx wrangler tail');
    expect(grantCovers(grant, noTrap, roots)).toBe(false);
  });

  it('a repo-scoped grant covers that repo\'s traps and no other', () => {
    const grant = addGrant({ mode: 'intent', by: 'glass', harness: 'any', repo: 'web', intent: { text: 'read logs', patterns: commandPatterns('npx wrangler tail') } });
    expect(grant.trap).toBeUndefined();
    expect(grantCovers(grant, asTrap('npx wrangler tail', { trap: 'early-pebble' }), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('npx wrangler tail', { harness: 'codex' }), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('npx wrangler tail', { repo: 'api' }), roots)).toBe(false);
    const { repo: _repo, ...noRepo } = asTrap('npx wrangler tail');
    expect(grantCovers(grant, noRepo, roots)).toBe(false);
  });

  it('must name a trap or a repo', () => {
    expect(() => addGrant({ mode: 'intent', by: 'glass', intent: { text: 'read logs', patterns: commandPatterns('npx wrangler tail') } })).toThrow(GrantError);
    expect(() => addGrant({ mode: 'intent', by: 'glass', trap: 'pearl-gull' })).toThrow(GrantError);
  });

  it('never covers a protected target, even when a pattern matches', () => {
    const grant = grantFor(commandPatterns('cat notes', 'cp notes *'));
    expect(grantCovers(grant, asTrap('cat notes'), roots)).toBe(true);
    expect(grantCovers(grant, asTrap('cat notes .lobstah/config.toml'), roots)).toBe(false);
    expect(grantCovers(grant, asTrap(`cp notes ${path.join(home, 'grants', 'ledger.jsonl')}`), roots)).toBe(false);
    expect(grantCovers(grant, asTrap('cp notes .claude/settings.json'), roots)).toBe(false);
  });
});

describe('expiry and revocation', () => {
  const hour = 3_600_000;
  it('a timed grant lapses, and an always grant stays until revoked', () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    const timed = grantFor(commandPatterns('npx wrangler tail'), { expiresAt: new Date(now + hour).toISOString() });
    const always = grantFor(commandPatterns('npx wrangler tail'));
    expect(grantActive(timed, now + hour - 1)).toBe(true);
    expect(grantActive(timed, now + hour)).toBe(false);
    expect(grantActive(always, now + 1000 * hour)).toBe(true);
  });

  it('a lapsed grant is not used, and many uses do not spend a live one', () => {
    const now = new Date('2026-11-05T12:00:00Z');
    grantFor(commandPatterns('npx wrangler tail'), { expiresAt: new Date(now.getTime() + hour).toISOString() });
    const within = new Date(now.getTime() + hour / 2);
    expect(useGrant(asTrap('npx wrangler tail a'), { now: within })?.mode).toBe('intent');
    expect(useGrant(asTrap('npx wrangler tail b'), { now: within })?.mode).toBe('intent');
    expect(useGrant(asTrap('npx wrangler tail c'), { now: new Date(now.getTime() + hour + 1) })).toBeUndefined();
  });

  it('a revoked grant stops at once, and is listed only with --all', () => {
    const grant = grantFor(commandPatterns('npx wrangler tail'));
    expect(useGrant(asTrap('npx wrangler tail'))?.id).toBe(grant.id);
    revokeGrant(grant.id, 'glass');
    expect(useGrant(asTrap('npx wrangler tail'))).toBeUndefined();
    expect(listGrants().grants).toEqual([]);
    expect(listGrants({ all: true }).grants[0]).toMatchObject({ id: grant.id, revokedBy: 'glass' });
  });
});

describe('audit', () => {
  it('records each use against the grant, with its tool and time, never the command text', () => {
    const grant = grantFor(commandPatterns('npx wrangler tail'));
    useGrant(asTrap('npx wrangler tail --secret-value-here'), { session: 's1', now: new Date('2026-11-05T12:00:00Z') });
    useGrant(asTrap('npx wrangler tail again'), { session: 's1', now: new Date('2026-11-05T12:05:00Z') });
    const [listed] = listGrants().grants;
    expect(listed).toMatchObject({ id: grant.id, uses: 2, lastUsedAt: '2026-11-05T12:05:00.000Z' });
    expect(listed!.audit?.map((entry) => [entry.tool, entry.at])).toEqual([
      ['Bash', '2026-11-05T12:00:00.000Z'],
      ['Bash', '2026-11-05T12:05:00.000Z'],
    ]);
    expect(fs.readFileSync(path.join(home, 'grants', 'ledger.jsonl'), 'utf8')).not.toContain('secret-value-here');
  });

  it('counts one call once, whichever hooks see it', () => {
    grantFor(commandPatterns('npx wrangler tail'));
    useGrant(asTrap('npx wrangler tail'), { callId: 'call-1' });
    useGrant(asTrap('npx wrangler tail'), { callId: 'call-1' });
    useGrant(asTrap('npx wrangler tail'), { callId: 'call-2' });
    expect(listGrants().grants[0]!.uses).toBe(2);
  });

  it('survives the ledger: the intent is read back as it was written', () => {
    const grant = grantFor([...commandPatterns('npx wrangler tail'), { kind: 'path', pattern: 'reports/' }]);
    expect(listGrants().grants[0]).toMatchObject({ id: grant.id, mode: 'intent', trap: 'pearl-gull', intent: grant.intent });
    expect(listGrants().intact).toBe(true);
  });

  it('`only` keeps other grants from being spent where only an intent should do', () => {
    addGrant({ mode: 'once', by: 'glass', harness: 'claude', command: 'npx wrangler tail', match: 'exact' });
    const { session: _session, ...request } = asTrap('npx wrangler tail');
    expect(useGrant(request, { only: 'intent' })).toBeUndefined();
    expect(listGrants().grants).toHaveLength(1);
    expect(listGrants().grants[0]!.uses).toBe(0);
  });
});

describe('what a trap may propose', () => {
  const intent = (...patterns: string[]) => ({ text: 'read logs', patterns: patterns.map(parseIntentPattern) });
  it('reads a pattern as a command, or by its tool: or path: lead, and shows it the same way', () => {
    expect(parseIntentPattern(' npx wrangler tail ')).toEqual({ kind: 'command', pattern: 'npx wrangler tail' });
    expect(parseIntentPattern('tool:mcp__x__*')).toEqual({ kind: 'tool', pattern: 'mcp__x__*' });
    expect(parseIntentPattern('path:reports/')).toEqual({ kind: 'path', pattern: 'reports/' });
    for (const raw of ['npx wrangler tail', 'tool:mcp__x__*', 'path:reports/']) expect(intentPatternText(parseIntentPattern(raw))).toBe(raw);
  });

  it.each([
    ['git', 'one word'],
    ['wrangler', 'one word'],
    ['* tail', 'literal word'],
    ['npx *', 'literal word'],
    ['scripts/with-timeout *', 'literal word'],
    ['scripts/with-timeout * bash -c', 'runs anything'],
    ['scripts/with-timeout 60 node x.js', 'runs anything'],
    ['npx * tail', 'glob choose'],
    ['bash -c', 'runs anything'],
    ['/bin/sh -c', 'runs anything'],
    ['python3 script.py', 'runs anything'],
    ['node script.js', 'runs anything'],
    ['sudo rm', 'runs anything'],
    ['env FOO=1', 'runs anything'],
    ['xargs rm', 'runs anything'],
    ['npx tsx script.ts', 'runs anything'],
    ['pnpm exec node x.js', 'runs anything'],
    ['npm run node', 'runs anything'],
    ['git status; rm x', 'shell syntax'],
    ['git status && x', 'shell syntax'],
    ['git status | sh', 'shell syntax'],
    ['git log > x', 'shell syntax'],
    ['git log $(id)', 'shell syntax'],
    ['lobstah grant x', 'its own permissions'],
    ['lobstah grants ls', 'its own permissions'],
    ['lobstah revoke g-1', 'its own permissions'],
    ['lobstah permissions apply', 'its own permissions'],
    ['lobstah trap bypass', 'its own permissions'],
    ['npx wrangler deploy --dry-run *', 'glob on a dry run'],
    ['tool:Bash', 'shell or file tool'],
    ['tool:*', 'start with a name'],
    ['tool:Write', 'shell or file tool'],
    ['tool:apply_patch', 'shell or file tool'],
    ['tool:exec_command', 'shell or file tool'],
    ['path:/etc/hosts', 'relative to the repo'],
    ['path:~/.ssh/', 'relative to the repo'],
    ['path:../other/', 'relative to the repo'],
    ['path:*', 'whole repo'],
    ['path:**', 'whole repo'],
    ['path:.git/hooks/', 'run code or hold configuration'],
    ['path:.husky/', 'run code or hold configuration'],
    ['path:.claude/settings.json', 'run code or hold configuration'],
    ['path:.lobstah/', 'run code or hold configuration'],
    ['path:.GIT/hooks/', 'run code or hold configuration'],
    ['path:.Claude/', 'run code or hold configuration'],
    ['path:src/.git/hooks/', 'run code or hold configuration'],
  ])('refuses %s', (raw, reason) => {
    expect(() => validateIntent(intent(raw))).toThrow(reason);
  });

  it.each(['npx wrangler tail', 'npx wrangler d1 execute *', 'scripts/with-timeout 60 npx wrangler tail', 'scripts/with-timeout * npx wrangler tail', 'gh pr view', 'git log --oneline', 'tool:mcp__cloudflare__*', 'path:reports/', 'path:notes/*.md'])(
    'accepts %s',
    (raw) => {
      expect(validateIntent(intent(raw)).patterns).toHaveLength(1);
    },
  );

  it('needs a short one-line label and at least one pattern, since the patterns are the grant', () => {
    const one = commandPatterns('git log');
    expect(() => validateIntent({ text: '  ', patterns: one })).toThrow('needs a sentence');
    expect(() => validateIntent({ text: 'x'.repeat(301), patterns: one })).toThrow('at most 300');
    expect(() => validateIntent({ text: 'read logs', patterns: [] })).toThrow('at least one pattern');
    expect(() => validateIntent({ text: 'x', patterns: Array.from({ length: 13 }, () => parseIntentPattern('git log')) })).toThrow('at most 12');
    expect(validateIntent({ text: 'read\n  logs now', patterns: one }).text).toBe('read logs now');
  });

  it('the label allows nothing: a command matches only by a pattern, whatever the sentence says', () => {
    const grant = addGrant({ mode: 'intent', by: 'glass', harness: 'any', trap: 'pearl-gull', intent: { text: 'run npx wrangler deploy whenever you like', patterns: commandPatterns('npx wrangler tail') } });
    expect(grantCovers(grant, asTrap('npx wrangler deploy'), roots)).toBe(false);
  });
});
