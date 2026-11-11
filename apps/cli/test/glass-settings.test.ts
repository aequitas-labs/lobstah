import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLayout, executorPath, lobstahVersion, signOnTrap } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { glassSettings, isSecretKey, looksSecret, maskSecrets, SECRET_MASK } from '../src/glass-settings.js';
import type { GlassSettings, SettingRow } from '../src/glass-settings.js';
import { loadGlass } from './glass-dom.js';
import { NOW, emptyFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// Assembled, so no scanner reads these made-up values as real ones.
const GITHUB_TOKEN = 'ghp_' + 'a1B2'.repeat(9);
const SLACK_WEBHOOK = 'https://hooks.slack.com/services/' + 'T000/B000/' + 'x'.repeat(24);
const BEARER = 'bearer-value-' + 'q'.repeat(12);
const NESTED_SECRET = 'nested-plain-' + 'w'.repeat(10);
const ARRAY_SECRET = 'array-plain-' + 'z'.repeat(10);
const ENV_VALUE = 'env-plain-' + 'y'.repeat(10);
const URL_PASSWORD = 'urlpass' + 'v'.repeat(10);
const FILE_ONLY_SECRET = 'file-only-' + 'u'.repeat(10);
const ALL_SECRETS = [GITHUB_TOKEN, SLACK_WEBHOOK, BEARER, NESTED_SECRET, ARRAY_SECRET, ENV_VALUE, URL_PASSWORD, FILE_ONLY_SECRET];

let home: string;
let repoDir: string;
const config = (): string => `
readySettleSecs = 30
attentionKinds = ["question", "pr:ready"]

[helm]
reportSecs = 1234

[repos.web]
path = "${repoDir.replace(/\\/g, '/')}"
origin = "https://builder:${URL_PASSWORD}@github.com/acme/web.git"
trunk = "main"
traps = 2
reviewTool = "linear-app"

[repos.web.env]
PLAIN_LOOKING = "${ENV_VALUE}"

[repos.auth-api]
path = "${repoDir.replace(/\\/g, '/')}"
trunk = "main"

[heavy]
slots = 3

[heavy.repos.web]
lightRefs = ["refs/heads/docs/*"]

[hooks.notify]
command = "curl -H 'Authorization: Bearer ${BEARER}' https://example.com/notify"

[grounds.product]
repos = ["web"]

[pickup.github]
token = "${FILE_ONLY_SECRET}"
owner = "acme"

[pickup.github.deep]
list = ["${GITHUB_TOKEN}", "plain-entry"]
webhooks = ["${ARRAY_SECRET}"]

[pickup.github.deep.credentials]
inner = "${NESTED_SECRET}"

[pickup.alerts]
url = "${SLACK_WEBHOOK}"
`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-settings-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  repoDir = path.join(home, 'repo');
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(home, 'config.toml'), config());
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
  delete process.env.CLAUDE_PLUGIN_ROOT;
});

const section = (page: GlassSettings, title: string): SettingRow[] => page.sections.find((s) => s.title === title)?.rows ?? [];
const row = (rows: SettingRow[], key: string): SettingRow | undefined => rows.find((r) => r.key === key);

describe('the masking rules', () => {
  it.each(['token', 'apiKey', 'api_key', 'GITHUB_TOKEN', 'webhookUrl', 'clientSecret', 'password', 'privateKey', 'authToken', 'credentials', 'env'])(
    'a key called %s is secret',
    (key) => expect(isSecretKey(key)).toBe(true),
  );
  it.each(['author', 'authors', 'keyboard', 'monkey', 'tokenizer', 'path', 'trunk', 'reviewTool', 'secretary', 'traps', 'environment'])(
    'a key called %s is not',
    (key) => expect(isSecretKey(key)).toBe(false),
  );
  it.each([
    GITHUB_TOKEN, 'github_pat_' + 'a'.repeat(30), 'sk-' + 'a'.repeat(30), 'xoxb-1234-abcd', 'AKIA' + 'A'.repeat(16),
    'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', '-----BEGIN RSA PRIVATE KEY-----', 'Authorization: Bearer abc', SLACK_WEBHOOK,
    'https://discord.com/api/webhooks/1/abc', 'https://example.com/hook?token=abc', 'https://user:pass@example.com/x',
    'FOO_TOKEN=abc ./run.sh', 'deploy --password hunter2', 'a'.repeat(64),
  ])('the value %s looks secret', (value) => expect(looksSecret(value)).toBe(true));
  it.each(['main', 'linear-app', 'git@github.com:acme/web.git', 'https://github.com/acme/web.git', 'pnpm install', '/home/someone/code/web', 'ntfy pub my-topic "$LOBSTAH_NOTE"', 'refs/heads/docs/*'])(
    'the value %s does not',
    (value) => expect(looksSecret(value)).toBe(false),
  );
  it('masks at any depth, in tables and arrays, and leaves the rest alone', () => {
    expect(maskSecrets({
      plain: 'main',
      count: 3,
      token: 'abc',
      nested: { apiKey: 12345, deeper: { secret: true, name: 'ok' } },
      list: ['ok', GITHUB_TOKEN, { password: 'abc', label: 'ok' }, ['x', SLACK_WEBHOOK]],
      keys: ['a', 'b'],
      credentials: { anything: 'abc', list: ['abc'] },
    })).toEqual({
      plain: 'main',
      count: 3,
      token: SECRET_MASK,
      nested: { apiKey: SECRET_MASK, deeper: { secret: SECRET_MASK, name: 'ok' } },
      list: ['ok', SECRET_MASK, { password: SECRET_MASK, label: 'ok' }, ['x', SECRET_MASK]],
      keys: [SECRET_MASK, SECRET_MASK],
      credentials: { anything: SECRET_MASK, list: [SECRET_MASK] },
    });
  });
  it('an empty secret stays empty: there is nothing to hide', () => {
    expect(maskSecrets({ token: '', password: null })).toEqual({ token: '', password: null });
  });
});

describe('the effective config', () => {
  it('sends no secret value, in any section, table or array', () => {
    const json = JSON.stringify(glassSettings());
    for (const secret of ALL_SECRETS) expect(json).not.toContain(secret);
    expect(json).toContain(SECRET_MASK);
  });

  it('masks each kind of value by its key or its shape', () => {
    const page = glassSettings();
    const web = page.repos.find((r) => r.key === 'web')!;
    expect(row(web.rows, 'origin')?.value).toBe(SECRET_MASK);
    expect(row(web.rows, 'env.PLAIN_LOOKING')?.value).toBe(SECRET_MASK);
    expect(row(section(page, 'Hooks'), 'notify.command')?.value).toBe(SECRET_MASK);
    const pickup = section(page, 'pickup');
    expect(row(pickup, 'github.token')?.value).toBe(SECRET_MASK);
    expect(row(pickup, 'github.deep.credentials.inner')?.value).toBe(SECRET_MASK);
    expect(row(pickup, 'github.deep.list')?.value).toBe(`${SECRET_MASK}, plain-entry`);
    expect(row(pickup, 'github.deep.webhooks')?.value).toBe(SECRET_MASK);
    expect(row(pickup, 'alerts.url')?.value).toBe(SECRET_MASK);
    expect(row(pickup, 'github.owner')?.value).toBe('acme');
  });

  it('a repo whose name looks like a secret still shows its settings', () => {
    const repo = glassSettings().repos.find((r) => r.key === 'auth-api')!;
    expect(row(repo.rows, 'trunk')?.value).toBe('main');
    expect(row(repo.rows, 'path')?.value).toBe(repoDir.replace(/\\/g, '/'));
  });

  it('marks what the file sets and what is a default', () => {
    const page = glassSettings();
    const helm = section(page, 'Helm');
    expect(row(helm, 'reportSecs')).toEqual({ key: 'reportSecs', value: '1234', source: 'config' });
    expect(row(helm, 'ttlSecs')?.source).toBe('default');
    expect(row(section(page, 'Heavy'), 'slots')).toEqual({ key: 'slots', value: '3', source: 'config' });
    expect(row(section(page, 'Heavy'), 'workers')).toMatchObject({ value: 'auto', source: 'default' });
    expect(row(section(page, 'Attention kinds'), 'attentionKinds')).toEqual({ key: 'attentionKinds', value: 'question, pr:ready', source: 'config' });
    expect(row(section(page, 'Attention timing'), 'readySettleSecs')).toEqual({ key: 'readySettleSecs', value: '30', source: 'config' });
  });

  it('with no config file, every value is a default', () => {
    fs.rmSync(path.join(home, 'config.toml'));
    const page = glassSettings();
    expect(page.error).toBeUndefined();
    expect(page.repos).toEqual([]);
    expect(page.sections.length).toBeGreaterThan(5);
    expect(page.sections.flatMap((s) => s.rows).every((r) => r.source === 'default')).toBe(true);
  });

  it('lists the grounds and each repo, with its per-repo settings and heavy rules', () => {
    const page = glassSettings();
    expect(page.grounds).toEqual([{ name: 'product', repos: ['web'] }]);
    expect(page.repos.map((r) => r.key)).toEqual(['auth-api', 'web']);
    const web = page.repos.find((r) => r.key === 'web')!;
    expect(row(web.rows, 'reviewTool')).toEqual({ key: 'reviewTool', value: 'linear-app', source: 'config' });
    expect(row(web.rows, 'heavy.lightRefs')).toEqual({ key: 'heavy.lightRefs', value: 'refs/heads/docs/*', source: 'config' });
    expect(row(page.repos.find((r) => r.key === 'auth-api')!.rows, 'reviewTool')).toEqual({ key: 'reviewTool', value: 'github', source: 'default' });
    expect(section(page, 'Heavy').some((r) => r.key.startsWith('repos'))).toBe(false);
  });

  it('with no grounds configured, shows the implicit home grounds holding every repo', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), config().replace('[grounds.product]\nrepos = ["web"]\n', ''));
    expect(glassSettings().grounds).toEqual([{ name: 'home', repos: ['web', 'auth-api'] }]);
  });

  it("shows each repo's trap count beside its cap", () => {
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree);
    signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'claude', sessionId: 'sess-settings', ttlMs: 60_000 });
    const page = glassSettings();
    expect(page.repos.find((r) => r.key === 'web')!.traps).toEqual({ used: 1, limit: 2 });
    expect(page.repos.find((r) => r.key === 'auth-api')!.traps).toEqual({ used: 0 });
  });

  it('a config that will not load is an error on the page, never a thrown request', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[pet]\nopen = "nowhere"\n');
    const page = glassSettings();
    expect(page.error).toContain('[pet].open');
    expect(page.sections).toEqual([]);
    expect(page.versions.rows[0]).toMatchObject({ name: 'CLI' });
  });

  it('an unparsable file never echoes what it holds', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), `token = "${GITHUB_TOKEN}"\nthis is not toml\n`);
    const page = glassSettings();
    expect(page.error).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain(GITHUB_TOKEN);
  });
});

describe('versions', () => {
  const NOW_MS = Date.parse('2026-11-05T12:00:00Z');
  const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
  // Only this test's plugins: never the ones installed on the machine running it.
  beforeEach(() => {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, 'codex');
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(realHome)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const daemon = (version: string, heartbeatAgeMs: number) =>
    fs.writeFileSync(executorPath(), JSON.stringify({ version, heartbeat: new Date(NOW_MS - heartbeatAgeMs).toISOString() }));
  const plugin = (version: string) => {
    const root = path.join(home, 'plugin');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lobstah', version }));
    process.env.CLAUDE_PLUGIN_ROOT = root;
  };

  it('says they match when the plugin and daemon are on the CLI version', () => {
    plugin(lobstahVersion());
    daemon(lobstahVersion(), 1000);
    const { versions } = glassSettings(NOW_MS);
    expect(versions.match).toBe(true);
    expect(versions.text).toBe('All match');
    expect(versions.rows.find((r) => r.name === 'Claude plugin')?.version).toBe(lobstahVersion());
    expect(versions.rows.find((r) => r.name === 'Daemon')).toEqual({ name: 'Daemon', version: lobstahVersion() });
  });

  it('names what differs, and a daemon that is not running', () => {
    plugin('0.0.1');
    daemon('0.0.2', 3_600_000);
    const { versions } = glassSettings(NOW_MS);
    expect(versions.match).toBe(false);
    expect(versions.text).toContain('Claude plugin');
    expect(versions.text).toContain('Daemon');
    expect(versions.rows.find((r) => r.name === 'Daemon')).toEqual({ name: 'Daemon', version: '0.0.2', note: 'not running' });
  });
});

describe('GET /data/settings', () => {
  const started = async () => {
    const server = serveGlass(0, { snapshot: buildGlassSnapshot });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return { server, port: (server.address() as AddressInfo).port };
  };
  /** A request with its own Host: the same server as a viewer off the machine reaches it. */
  const getAs = (port: number, host: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/data/settings', headers: { host } }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });

  it('serves the masked settings read-only, and refuses every write', async () => {
    const { server, port } = await started();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/data/settings`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
      expect((JSON.parse(text) as GlassSettings).repos.map((r) => r.key)).toEqual(['auth-api', 'web']);
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect((await fetch(`http://127.0.0.1:${port}/data/settings`, { method })).status).toBe(405);
      }
      expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(config());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('is masked the same for a viewer off the machine', async () => {
    const { server, port } = await started();
    try {
      const { status, body } = await getAs(port, 'glass.example');
      expect(status).toBe(200);
      for (const secret of ALL_SECRETS) expect(body).not.toContain(secret);
      expect(body).toContain(SECRET_MASK);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the Settings tab', () => {
  const page: GlassSettings = {
    file: '/home/someone/.lobstah/config.toml',
    versions: { rows: [{ name: 'CLI', version: '1.2.3' }, { name: 'Daemon', version: '1.2.2', note: 'not running' }], match: false, text: 'Daemon differs from the CLI' },
    grounds: [{ name: 'product', repos: ['web', 'api'] }],
    repos: [
      { key: 'web', traps: { used: 3, limit: 2 }, rows: [{ key: 'reviewTool', value: 'linear-app', source: 'config' }] },
      { key: 'api', traps: { used: 1 }, rows: [{ key: 'reviewTool', value: 'github', source: 'default' }] },
    ],
    sections: [{ title: 'Helm', rows: [{ key: 'reportSecs', value: '1234', source: 'config' }, { key: 'token', value: SECRET_MASK, source: 'config' }, { key: 'ttlSecs', value: '300', source: 'default' }] }],
  };
  const open = (settings?: GlassSettings) => loadGlass(GLASS_PAGE, emptyFleet(), { now: NOW, hash: '#settings', ...(settings ? { settings } : {}) });

  it('renders each section with its values and where they came from', async () => {
    const g = await open(page);
    try {
      const rows = g.$$('#settings .cfgrow').map((el) => [...el.children].map((c) => c.textContent));
      expect(rows).toContainEqual(['reportSecs', '1234', 'Set']);
      expect(rows).toContainEqual(['ttlSecs', '300', 'Default']);
      expect(rows).toContainEqual(['token', SECRET_MASK, 'Set']);
      expect(rows).toContainEqual(['product', 'web, api', '']);
      expect(rows).toContainEqual(['Daemon', '1.2.2', 'not running']);
      const headings = g.$$('#settings h2').map((h) => h.textContent);
      // The local glass leads with its run passkeys; then the configuration.
      expect(headings).toEqual(['Run cards', 'Versions', 'Grounds', 'Repos', 'Helm']);
      expect(g.$('#settings')?.textContent).toContain('Daemon differs from the CLI');
    } finally {
      await g.close();
    }
  });

  it("shows each repo's trap count beside its cap, and a count past it", async () => {
    const g = await open(page);
    try {
      const repos = g.$$('#settings .cfgrepo h3').map((h) => h.textContent);
      expect(repos).toEqual(['web 3 of 2 traps, over the cap', 'api 1 trap, no cap']);
    } finally {
      await g.close();
    }
  });

  it('is read-only: no control can change a setting', async () => {
    const g = await open(page);
    try {
      expect(g.$$('#settings input, #settings select, #settings textarea, #settings button, #settings form')).toEqual([]);
    } finally {
      await g.close();
    }
  });

  it('says when the settings could not be read', async () => {
    const g = await open();
    try {
      expect(g.$('#settings')?.textContent).toContain('Settings could not be read');
    } finally {
      await g.close();
    }
  });
});
