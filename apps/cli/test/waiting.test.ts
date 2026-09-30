import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, enqueue, ensureLayout, readStatusLog } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-waiting-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

const id = 'bbbbbbbb-1111-2222-3333-444444444444';
const LINK = 'https://ume.example.com/s/abc';

function active(): void {
  enqueue({ id, repo: 'web', brief: 'work' });
  claimNext('work');
  appendStatus(id, 'work', 'working');
}

describe('report paused --waiting-on --link', () => {
  it('round-trips through the CLI and shows in status, ls, tend, and the glass', () => {
    active();
    const rep = lobstah('report', id, 'paused', 'plan is in human review', '--waiting-on', 'review', '--link', LINK, '--until', '8h');
    expect(rep.status, rep.stdout).toBe(0);
    expect(rep.stdout).toContain('waitingOn: review');
    expect(rep.stdout).toContain(`link: ${LINK}`);
    const e = readStatusLog(id, 'work').at(-1)!;
    expect(e).toMatchObject({ verb: 'paused', note: 'plan is in human review', waitingOn: 'review', link: LINK });
    expect(e.until).toBeDefined();

    const status = lobstah('status', id);
    expect(status.stdout).toContain('state: paused');
    expect(status.stdout).toMatch(new RegExp(`^paused: waiting on review for \\ds ${LINK}$`, 'm'));
    expect(status.stdout).toContain(`until: ${e.until}`);

    expect(lobstah('ls').stdout).toMatch(new RegExp(`${id},work,active,paused,[^,]+,waiting on review for \\ds ${LINK},`));

    const tend = buildTendReport();
    const d = tend.stories.flatMap((s) => s.dispatches).find((x) => x.id === id)!;
    expect(d.waiting).toMatchObject({ on: 'review', link: LINK, since: e.at });
    expect(renderTend(tend)).toContain(`${id.slice(0, 8)}:paused (waiting on review for`);
    // paused is a state, not a question: no attention.
    expect(tend.attention).toEqual([]);
    expect(tend.verdict).not.toBe('needs-attention');

    const g = buildGlassSnapshot().dispatches.find((x) => x.id === id)!;
    expect(g.waiting).toMatchObject({ on: 'review', link: LINK, since: e.at });
  });

  it('refuses --waiting-on and --link on other verbs, and unknown kinds (exit 2)', () => {
    active();
    for (const args of [
      ['done', 'x', '--link', LINK],
      ['working', '--waiting-on', 'review'],
      ['paused', '--waiting-on', 'lunch'],
      ['paused', '--link', 'javascript:alert(1)'],
    ]) {
      const res = lobstah('report', id, ...args);
      expect(res.status, args.join(' ')).toBe(2);
    }
    expect(readStatusLog(id, 'work').map((e) => e.verb)).toEqual(['working']);
  });
});
