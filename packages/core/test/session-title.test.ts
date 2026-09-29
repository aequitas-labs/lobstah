import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimBait, cleanTitleText, enqueue, ensureLayout, signOnTrap, trapSessionTitle, titleFromBrief } from '../src/index.js';

let home: string;
let worktree: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-title-'));
  worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function signOn() {
  const result = signOnTrap({ sessionId: 'own-session', harness: 'codex', repo: 'web', worktree, cwd: worktree, ttlMs: 1_800_000, name: 'amber-gull' });
  if ('held' in result) throw new Error('unexpected hold');
  return result.ok;
}

describe('trap session title', () => {
  it('is absent outside the caller\'s signed-on trap', () => {
    expect(trapSessionTitle({ sessionId: 'own-session', cwd: worktree })).toBeUndefined();
    signOn();
    expect(trapSessionTitle({ sessionId: 'another-session', cwd: worktree })).toBeUndefined();
    expect(trapSessionTitle({ cwd: home })).toBeUndefined();
  });

  it('uses the name while idle, the short brief when claimed, and the name after completion', () => {
    const reg = signOn();
    expect(trapSessionTitle({ sessionId: 'own-session', cwd: worktree })).toEqual({ title: 'amber-gull', name: 'amber-gull', work: null });
    enqueue({ id: 'title-work', repo: 'web', brief: '# Build session titles for every active trap in the sidebar\nMore details' });
    claimBait(reg);
    expect(trapSessionTitle({ sessionId: 'own-session', cwd: worktree })).toEqual({
      title: 'amber-gull · Build session titles for every active',
      name: 'amber-gull',
      work: 'Build session titles for every active',
    });
    appendStatus('title-work', 'work', 'done', 'finished');
    expect(trapSessionTitle({ sessionId: 'own-session', cwd: worktree })?.title).toBe('amber-gull');
  });

  it('strips terminal sequences and controls, keeps shell punctuation as text, and caps the title', () => {
    const brief = `## \u001b[31mShip "quoted" \`backtick\` $(echo danger) ${'long '.repeat(100)}\u001b[0m\nsecond line`;
    const title = titleFromBrief(brief);
    expect(title).toContain('"quoted"');
    expect(title).toContain('`backtick`');
    expect(title).toContain('$(echo danger)');
    expect(title).not.toContain('\u001b');
    expect(title).not.toContain('second line');
    expect(Array.from(title).length).toBeLessThanOrEqual(40);
    expect(titleFromBrief('\u001b]0;window title\u0007# Safe work\nignored')).toBe('Safe work');
    expect(cleanTitleText('safe\u001bPbad\u001b\\ title')).toBe('safe title');
  });
});
