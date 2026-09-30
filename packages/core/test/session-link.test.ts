import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, readTrap, signOnTrap, validSessionLink } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let worktree: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-session-link-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const opts = () => ({ worktree, cwd: worktree, sessionId: 'session-one', harness: 'claude', ttlMs: 60_000 });

describe('session links', () => {
  it('accepts only the three exact session URL forms', () => {
    expect(validSessionLink('claude://claude.ai/epitaxy/local_4752d6e4-f9b4-4c2e-ac21-ed17b749b169')).toBe(true);
    expect(validSessionLink('vscode://anthropic.claude-code/open?session=a_B-2')).toBe(true);
    expect(validSessionLink('codex://threads/01a0ceb8-b9bd-7d42-927c-c52a334b8e2d')).toBe(true);
    for (const link of [
      'javascript:alert(1)', 'file:///tmp/x', 'http://claude.ai/a',
      'claude://elsewhere/a', 'claude://claude.ai/a\'b', 'claude://claude.ai/a\nb', 'claude://claude.ai/a\n',
      'vscode://anthropic.claude-code/open?session=x&other=y',
      'codex://threads/a_b',
    ]) expect(validSessionLink(link)).toBe(false);
  });

  it('rejects a bad link at write time without creating a trap and keeps a valid one', () => {
    expect(() => signOnTrap({ ...opts(), link: 'file:///tmp/x' })).toThrow(/invalid session link/);
    expect(fs.existsSync(path.join(worktree, '.lobstah-trap'))).toBe(false);
    const first = signOnTrap({ ...opts(), link: 'codex://threads/a-b' });
    expect('ok' in first && readTrap(first.ok.trapId)?.link).toBe('codex://threads/a-b');
    const again = signOnTrap(opts());
    expect('ok' in again && again.ok.link).toBe('codex://threads/a-b');
  });

  it('does not carry a previous session link into a new session', () => {
    signOnTrap({ ...opts(), link: 'vscode://anthropic.claude-code/open?session=x' });
    const next = signOnTrap({ ...opts(), sessionId: 'session-two', now: Date.now() + 120_000 });
    expect('ok' in next && next.ok.link).toBeUndefined();
  });
});
