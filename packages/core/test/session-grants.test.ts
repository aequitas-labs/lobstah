import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addGrant, grantCovers, listGrants, revokeGrant, useGrant, grantsDir } from '../src/index.js';
import type { GrantRequest } from '../src/index.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-session-grants-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});
const request = (
  tool = 'mcp__browser__navigate',
  input: Record<string, unknown> = { url: 'https://dash.cloudflare.com/secret?token=FAKE' },
): GrantRequest => ({ harness: 'claude', session: 'helm-session', tool, input, cwd: home });
const grant = (extra = {}) =>
  addGrant({ mode: 'session', session: 'helm-session', tools: 'mcp__browser__*', hosts: ['dash.cloudflare.com'], by: 'glass', ...extra });
it('pins one session, exact/glob tools and URL hosts while allowing URL-less clicks', () => {
  const g = grant();
  expect(grantCovers(g, request())).toBe(true);
  expect(grantCovers(g, { ...request(), session: 'other' })).toBe(false);
  expect(grantCovers(g, { ...request(), session: undefined })).toBe(false);
  expect(grantCovers(g, request('mcp__browser__computer', { action: 'click', coordinate: [4, 9] }))).toBe(true);
  expect(grantCovers(g, request('mcp__other__navigate'))).toBe(false);
  for (const url of ['https://dash.cloudflare.com.evil.test/', 'https://example.com/', 'file:///etc/passwd', 'bad'])
    expect(grantCovers(g, request(undefined, { url }))).toBe(false);
  expect(grantCovers(g, request(undefined, {}))).toBe(false);
  const exact = grant({ tools: 'WebFetch' });
  expect(grantCovers(exact, request('WebFetch'))).toBe(true);
  expect(grantCovers(exact, request('WebFetchMore'))).toBe(false);
});
it('requires an expiring window, defaults to 15m, caps at 4h, and stops immediately on revoke/expiry', () => {
  const now = new Date();
  const g = grant();
  expect(Date.parse(g.expiresAt!) - Date.parse(g.at)).toBe(900_000);
  expect(() => grant({ expiresAt: new Date(now.getTime() + 4 * 3600_000 + 5000).toISOString() })).toThrow('4h');
  expect(() => grant({ session: undefined })).toThrow('one session');
  expect(useGrant(request())).toBeDefined();
  revokeGrant(g.id, 'glass');
  expect(useGrant(request())).toBeUndefined();
  expect(grantCovers({ ...g, revokedAt: new Date().toISOString() }, request())).toBe(false);
  expect(grantCovers({ ...g, expiresAt: new Date(Date.now() - 1).toISOString() }, request())).toBe(false);
});
it('records count and only tool/time/host audit, with hook call-id deduplication', () => {
  const g = grant();
  const req = request('mcp__browser__computer', {
    action: 'type',
    text: 'NEVER_LOG_THIS_SECRET',
    url: 'https://dash.cloudflare.com/private?q=NEVER_LOG_QUERY',
  });
  useGrant(req, { session: req.session, callId: 'same-call' });
  useGrant(req, { session: req.session, callId: 'same-call' });
  const read = listGrants().grants[0]!;
  expect(read.uses).toBe(1);
  expect(read.audit).toEqual([{ tool: req.tool, at: expect.any(String), hosts: ['dash.cloudflare.com'] }]);
  const ledger = fs.readFileSync(path.join(grantsDir(), 'ledger.jsonl'), 'utf8');
  expect(ledger).not.toContain('NEVER_LOG');
  expect(ledger).not.toContain('/private');
  expect(read.id).toBe(g.id);
});
it.each(['lobstah grant anything', 'lobstah --json grant anything', 'lobstah trap grant anything'])(
  'never covers self-granting: %s',
  (command) => {
    const g = grant({ tools: 'Bash', command: 'lobstah', match: 'prefix', hosts: [] });
    expect(grantCovers(g, { ...request('Bash', { command }), command })).toBe(false);
  },
);
it.each([
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  '.codex/settings.json',
  'grants/ledger.jsonl',
  'config.toml',
])('refuses protected target %s, including relative paths', (file) => {
  const g = grant({ tools: 'Write', hosts: [] });
  expect(grantCovers(g, request('Write', { file_path: file, content: 'data' }))).toBe(false);
});
it.each(['.claude/settings.json', '.codex/config.toml', '.ClAuDe/SeTtInGs.JsOn', 'grants/ledger.jsonl', 'config.toml'])(
  'resolves symlinks before allowing a file write to %s',
  (name) => {
    const g = grant({ tools: 'Write', hosts: [] });
    const target = path.join(home, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, path.join(home, 'innocent'), 'file');
    expect(grantCovers(g, request('Write', { file_path: 'innocent', content: 'data' }))).toBe(false);
  },
);
it.each([
  ['CLAUDE_CONFIG_DIR', 'settings.local.json'],
  ['CODEX_HOME', 'rules/new-rule'],
])('resolves directory links and missing descendants under %s', (variable, name) => {
  const target = path.join(home, 'custom-settings');
  fs.mkdirSync(target);
  vi.stubEnv(variable!, target);
  fs.symlinkSync(target, path.join(home, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const g = grant({ tools: 'Write', hosts: [] });
  expect(grantCovers(g, request('Write', { file_path: path.join('alias', name!), content: 'data' }))).toBe(false);
  expect(grantCovers(g, request('Write', { file_path: path.join('alias', 'notes.txt'), content: 'data' }))).toBe(true);
});
it('allows symlink writes to an ordinary file', () => {
  fs.writeFileSync(path.join(home, 'notes.txt'), 'notes');
  fs.symlinkSync(path.join(home, 'notes.txt'), path.join(home, 'innocent'), 'file');
  const g = grant({ tools: 'Write', hosts: [] });
  expect(grantCovers(g, request('Write', { file_path: 'innocent', content: 'data' }))).toBe(true);
});
it.each(['.claude/settings.json', '.codex/config.toml'])('refuses a dangling file link to %s', (name) => {
  const target = path.join(home, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(path.relative(home, target), path.join(home, 'innocent'), 'file');
  const g = grant({ tools: 'Write', hosts: [] });
  expect(grantCovers(g, request('Write', { file_path: 'innocent', content: 'data' }))).toBe(false);
});
it('Bash requires a prefix and reuses joiner and dry-run protections', () => {
  expect(() => grant({ tools: 'Bash' })).toThrow('prefix');
  const g = grant({ tools: 'Bash', command: 'npx wrangler deploy --dry-run', match: 'prefix', hosts: [] });
  const covers = (command: string) => grantCovers(g, { ...request('Bash', { command }), command });
  expect(covers('npx wrangler deploy --dry-run --outdir tmp')).toBe(true);
  for (const tail of ['; echo x', ' && echo x', ' | cat', ' > a', ' --dry-run=false', ' --no-dry-run'])
    expect(covers(g.command + tail)).toBe(false);
});
