import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, without declarations
import { localProblem, mergeLocal, parseJsonc } from '../../../services/wharf/scripts/wrangler-local.mjs';

/**
 * The wharf's own ids stay out of git: wrangler.jsonc keeps a placeholder
 * database id, and services/wharf/scripts/wrangler-local.mjs merges this
 * machine's git-ignored wrangler.local.jsonc in before wrangler runs. It
 * refuses to run without that file, or with a placeholder in it, and never
 * prints the id.
 */

const wharf = fileURLToPath(new URL('../../../services/wharf/', import.meta.url));
const config = () => parseJsonc(fs.readFileSync(path.join(wharf, 'wrangler.jsonc'), 'utf8'));
const REAL = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

describe('the committed wharf config', () => {
  it('holds no deployment id: a placeholder database id, no client id, and keeps the Worker’s own variables', () => {
    const c = config();
    expect(c.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(c.vars).not.toHaveProperty('GITHUB_CLIENT_ID');
    expect(c.keep_vars).toBe(true);
  });

  it('ignores the local file and the merged config it writes', () => {
    const ignored = (file: string) => spawnSync('git', ['check-ignore', '-q', path.join(wharf, file)], { cwd: wharf }).status === 0;
    expect(ignored('wrangler.local.jsonc')).toBe(true);
    expect(ignored('wrangler.deploy.jsonc')).toBe(true);
    expect(ignored('wrangler.local.example.jsonc')).toBe(false);
  });

  it('ships an example that the script refuses as a placeholder', () => {
    const example = parseJsonc(fs.readFileSync(path.join(wharf, 'wrangler.local.example.jsonc'), 'utf8'));
    expect(localProblem(example)).toBe('"database_id" is still the placeholder');
  });
});

describe('merging this machine’s ids', () => {
  it('reads JSONC as wrangler does, keeping // inside strings', () => {
    expect(parseJsonc('{\n  // a comment\n  "url": "https://glass.lobstah.dev", /* more */ "list": [1, 2,],\n}')).toEqual({
      url: 'https://glass.lobstah.dev',
      list: [1, 2],
    });
  });

  it('puts the local id into the deployed binding only', () => {
    const merged = mergeLocal(config(), { database_id: REAL });
    expect(merged.d1_databases[0].database_id).toBe(REAL);
    expect(merged.env.local.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(merged.routes).toEqual(config().routes);
  });

  it('names what is wrong with a local file, never the id', () => {
    expect(localProblem({ database_id: REAL })).toBeUndefined();
    expect(localProblem({})).toBe('it has no "database_id"');
    expect(localProblem({ database_id: 'not-an-id' })).toBe('"database_id" is not a D1 database id (a lowercase UUID)');
    expect(localProblem([])).toBe('it has no "database_id"');
  });
});

describe('the deploy refuses to run without a usable local file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** The script and committed config in a scratch copy of services/wharf, so the real local file is never touched. */
  function copy(local?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wharf-local-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(wharf, 'scripts', 'wrangler-local.mjs'), path.join(dir, 'scripts', 'wrangler-local.mjs'));
    fs.copyFileSync(path.join(wharf, 'wrangler.jsonc'), path.join(dir, 'wrangler.jsonc'));
    if (local !== undefined) fs.writeFileSync(path.join(dir, 'wrangler.local.jsonc'), local);
    return (...args: string[]) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'wrangler-local.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  }

  it('fails loudly when the local file is missing, before wrangler runs', () => {
    const run = copy()('deploy');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('wrangler.local.jsonc is missing');
    expect(run.stderr).toContain('wrangler.local.example.jsonc');
  });

  it('fails loudly on a placeholder or malformed id, and never echoes it', () => {
    const placeholder = copy('{ "database_id": "00000000-0000-0000-0000-000000000000" }')('deploy');
    expect(placeholder.status).toBe(1);
    expect(placeholder.stderr).toContain('"database_id" is still the placeholder');
    const malformed = copy('{ "database_id": "abc-secretish" }')('d1', 'migrations', 'apply', 'lobstah-wharf-auth', '--remote');
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('is not a D1 database id');
    expect(malformed.stderr + malformed.stdout).not.toContain('abc-secretish');
  });

  it('asks for a wrangler command', () => {
    const run = copy(`{ "database_id": "${REAL}" }`)();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('name a wrangler command');
  });
});
