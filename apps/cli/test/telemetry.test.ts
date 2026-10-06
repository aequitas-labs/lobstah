import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TELEMETRY_FIELDS, TELEMETRY_NOTICE } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-telemetry-cli-'));
});
afterEach(() => removeTempDir(home));

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home, ...extra };
  for (const k of ['CI', 'DO_NOT_TRACK', 'LOBSTAH_TELEMETRY']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [cli, 'telemetry', ...args], { encoding: 'utf8', env });
}

describe('lobstah telemetry', () => {
  it('show prints exactly the allowed keys, and nothing of the home path', () => {
    const r = run(['show']);
    expect(r.status).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout) as object)).toEqual([...TELEMETRY_FIELDS]);
    expect(JSON.parse(r.stdout)).toMatchObject({ schema: 1, catches: { today: 0, total: 0 }, traps: [] });
    expect(r.stdout).not.toContain(home);
  });

  it('status reports the empty endpoint and each off switch; disable writes the config', () => {
    expect(run(['status']).stdout).toContain('endpoint: (none — this build sends nothing)');
    expect(JSON.parse(run(['status', '--json'], { DO_NOT_TRACK: '1' }).stdout)).toMatchObject({ sharing: false, offBy: ['env: DO_NOT_TRACK'] });
    expect(run(['disable']).stdout).toContain('sharing: off');
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain('[telemetry]\nshare = false');
    // The DO_NOT_TRACK run above is remembered for the daemon until an
    // interactive run without it: enable sets the config, sharing stays off.
    const enabled = run(['enable']).stdout;
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain('[telemetry]\nshare = true');
    expect(enabled).toContain('Still off: env: DO_NOT_TRACK');
  });

  it('prints no notice on a non-interactive run', () => {
    const r = spawnSync(process.execPath, [cli, 'version'], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home } });
    expect(r.stderr).not.toContain('lobstah telemetry');
  });

  it('PRIVACY.md quotes the notice word for word and documents every field', () => {
    const privacy = fs.readFileSync(fileURLToPath(new URL('../../../PRIVACY.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const unindented = privacy.replace(/^ {2}/gm, '');
    expect(unindented).toContain(TELEMETRY_NOTICE);
    for (const field of TELEMETRY_FIELDS) expect(privacy).toContain(`| \`${field}\` |`);
    expect(privacy).toContain('unknown provenance, stay local');
  });
});
