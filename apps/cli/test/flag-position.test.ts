import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimNext, enqueue, ensureLayout, readEvidence, readStatusLog, unhandled } from '@lobstah/core';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`):
// the bug was a trailing `--session` read as message text in main.ts, so
// only a real invocation shows it.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HELM = '7e740e13-0000-4000-8000-000000000001';
const ID = '51151151-1111-4111-8111-111111111111';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-flagpos-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  enqueue({ id: ID, repo: 'r', brief: 'b' });
  claimNext('work');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  // Never inherit the test runner's own harness session id.
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

function claimHelm() {
  const res = lobstah('man', 'helm', '--session', HELM);
  expect(res.status, res.stdout).toBe(0);
}

const messages = () => unhandled(ID, 'work').map((m) => m.text);

describe('send — --session is honored in any position', () => {
  const placements: Array<[string, string[]]> = [
    ['trailing', [ID, 'B, with one refinement', '--session', HELM]],
    ['leading', ['--session', HELM, ID, 'B, with one refinement']],
    ['between target and message', [ID, '--session', HELM, 'B, with one refinement']],
  ];
  for (const [where, argv] of placements) {
    it(`identifies the helm with --session ${where}, and never leaks the flag into the message`, () => {
      claimHelm();
      const res = lobstah('send', ...argv);
      expect(res.status, res.stdout).toBe(0);
      expect(res.stdout).toContain('from: helm');
      expect(messages()).toEqual(['[from helm]\nB, with one refinement']);
    });
  }

  it('keeps a literal flag after the -- terminator', () => {
    claimHelm();
    const res = lobstah('send', '--session', HELM, ID, '--', '--session literal', '--pr');
    expect(res.status, res.stdout).toBe(0);
    expect(messages()).toEqual(['[from helm]\n--session literal --pr']);
  });

  it('a refusal says no session was given or resolved', () => {
    claimHelm();
    const res = lobstah('send', ID, 'hello');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('no --session given and none resolved from the environment');
    expect(messages()).toEqual([]);
  });

  it('a refusal names the session it resolved and where from', () => {
    claimHelm();
    const res = lobstah('send', ID, 'hello', '--session', 'not-the-helm');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('resolved session not-the-helm from --session');
  });
});

describe('report — --pr is honored in any position', () => {
  const placements: Array<[string, string[]]> = [
    ['after the note', [ID, 'done', 'brief fulfilled', '--pr', 'https://x/pull/1']],
    ['before the note', [ID, 'done', '--pr', 'https://x/pull/1', 'brief fulfilled']],
  ];
  for (const [where, argv] of placements) {
    it(`records the same note and URL with --pr ${where}`, () => {
      const res = lobstah('report', ...argv);
      expect(res.status, res.stdout).toBe(0);
      expect(readStatusLog(ID, 'work').at(-1)).toMatchObject({ verb: 'done', note: 'brief fulfilled' });
      expect(readEvidence(ID, 'work').prUrl).toBe('https://x/pull/1');
    });
  }

  it('keeps a literal --pr in the note after --', () => {
    const res = lobstah('report', ID, 'working', '--', 'wiring', '--pr', 'next');
    expect(res.status, res.stdout).toBe(0);
    expect(readStatusLog(ID, 'work').at(-1)?.note).toBe('wiring --pr next');
    expect(readEvidence(ID, 'work').prUrl).toBeUndefined();
  });
});

describe('unknown flags still fail loudly', () => {
  it('exits 2 with the usage card, in any position', () => {
    for (const argv of [
      ['send', ID, 'hello', '--sesion', HELM],
      ['send', '--sesion', HELM, ID, 'hello'],
      ['report', ID, 'done', 'note', '--pr-url', 'x'],
    ]) {
      const res = lobstah(...argv);
      expect(res.status, argv.join(' ')).toBe(2);
      expect(res.stdout).toMatch(/unknown flag --(sesion|pr-url)/);
      expect(res.stdout).toContain(`lobstah ${argv[0]}`);
    }
    expect(messages()).toEqual([]);
  });
});
