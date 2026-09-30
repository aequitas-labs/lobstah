import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ActivityTracker,
  activityFromEvent,
  activityLine,
  activityView,
  commandWord,
  ensureLayout,
  readActivity,
  redactSummary,
  relativeTarget,
  toolSummary,
  toolTarget,
  writeActivity,
} from '../src/index.js';
import type { Activity } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-activity-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.useRealTimers();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('tool summaries: name and primary target, nothing else', () => {
  it('shows a file path relative to the worktree', () => {
    expect(toolSummary('Edit', toolTarget({ file_path: '/wt/app/src/a.ts', old_string: 'x', new_string: 'y' }), '/wt/app')).toBe('Edit src/a.ts');
    expect(toolSummary('Read', toolTarget({ file_path: '/etc/hosts' }), '/wt/app')).toBe('Read …/hosts');
  });

  it('relativizes Windows paths with forward slashes', () => {
    expect(relativeTarget('C:\\Users\\me\\wt\\src\\a.ts', 'C:\\Users\\me\\wt')).toBe('src/a.ts');
    expect(toolSummary('Edit', 'C:\\Users\\me\\wt\\src\\a.ts', 'C:\\Users\\me\\wt')).toBe('Edit src/a.ts');
  });

  it("shows a command's first word only: no arguments, no env values", () => {
    expect(toolSummary('Bash', toolTarget({ command: `GH_TOKEN=${TOKEN} gh pr create --body "secret plan"` }))).toBe('Bash gh');
    expect(commandWord('/usr/bin/git status')).toBe('git');
    expect(commandWord("bash -lc 'pnpm test'")).toBe('pnpm');
    expect(commandWord('env -i FOO=1 node x.js')).toBe('node');
    expect(commandWord('C:\\tools\\node.exe script.js')).toBe('node');
  });

  it("shows a URL's host only: no credentials, path, or query", () => {
    expect(toolSummary('WebFetch', toolTarget({ url: `https://user:${TOKEN}@api.example.com/v1?key=${TOKEN}`, prompt: 'x' }))).toBe(
      'WebFetch api.example.com',
    );
  });

  it('a tool input containing a token never reaches the summary', () => {
    const inputs = [
      { command: `curl -H "Authorization: Bearer ${TOKEN}" https://x` },
      { command: `${TOKEN} --do-it` },
      { file_path: `/wt/app/${TOKEN}.txt` },
      { url: `https://${TOKEN}.example.com/` },
      { prompt: TOKEN, content: TOKEN },
    ];
    for (const input of inputs) {
      const s = toolSummary('Tool', toolTarget(input), '/wt/app');
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain('ghp_');
    }
    for (const secret of ['sk-ant-api03-abcdefghijklmnop', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'password=hunter2']) {
      expect(redactSummary(`Bash ${secret}`)).toBe('Bash [redacted]');
    }
    expect(redactSummary('Edit src/auth/token-store.ts')).toBe('Edit src/auth/token-store.ts');
  });

  it('caps the summary at 80 characters', () => {
    const s = toolSummary('Read', `/wt/${'a/'.repeat(100)}file.ts`, '/wt');
    expect(s.length).toBeLessThanOrEqual(80);
  });
});

describe('activity from events', () => {
  it('maps tool, message, thinking, and waiting', () => {
    expect(activityFromEvent({ at: '', type: 'tool-start', data: { name: 'Edit', target: '/wt/a.ts' } }, '/wt')).toEqual({ kind: 'tool', summary: 'Edit a.ts' });
    expect(activityFromEvent({ at: '', type: 'text', data: { text: `the key is ${TOKEN}` } })).toEqual({ kind: 'message', summary: 'writing a message' });
    expect(activityFromEvent({ at: '', type: 'thinking', data: {} })?.kind).toBe('thinking');
    expect(activityFromEvent({ at: '', type: 'runner', data: { waiting: 'needs-decision' } })?.kind).toBe('waiting');
    expect(activityFromEvent({ at: '', type: 'runner', data: { holding: 'background' } })?.kind).toBe('waiting');
    expect(activityFromEvent({ at: '', type: 'turn-end', data: {} })).toBeUndefined();
  });

  it('round-trips through the state file, redacted', () => {
    writeActivity('d1', 'work', { at: '2026-01-01T00:00:00.000Z', kind: 'tool', summary: `Bash ${TOKEN}` });
    expect(readActivity('d1', 'work')).toEqual({ at: '2026-01-01T00:00:00.000Z', kind: 'tool', summary: 'Bash [redacted]' });
    expect(readActivity('none', 'work')).toBeUndefined();
  });

  it('marks activity stale past the threshold', () => {
    const now = Date.parse('2026-01-01T00:20:00.000Z');
    const a: Activity = { at: '2026-01-01T00:05:00.000Z', kind: 'tool', summary: 'Edit a.ts' };
    const stale = activityView(a, 600, now)!;
    expect(stale.stale).toBe(true);
    expect(activityLine(stale)).toBe('stale: Edit a.ts (15m ago)');
    const fresh = activityView({ ...a, at: '2026-01-01T00:19:48.000Z' }, 600, now)!;
    expect(fresh.stale).toBe(false);
    expect(activityLine(fresh)).toBe('Edit a.ts (12s ago)');
  });
});

describe('ActivityTracker throttling', () => {
  it('writes at most once per window, plus once on every change of kind', () => {
    vi.useFakeTimers();
    let t = 0;
    const writes: Activity[] = [];
    const tracker = new ActivityTracker((a) => writes.push(a), { throttleMs: 10_000, now: () => t });
    const tool = (name: string) => tracker.observe({ at: '', type: 'tool-start', data: { name } });
    tool('Read'); // first write
    t = 1000;
    tool('Edit'); // same kind, inside the window: held
    t = 2000;
    tool('Grep'); // replaces the held one
    expect(writes.map((w) => w.summary)).toEqual(['Read']);
    t = 3000;
    tracker.observe({ at: '', type: 'thinking', data: {} }); // kind change: written now
    expect(writes.map((w) => w.kind)).toEqual(['tool', 'thinking']);
    t = 4000;
    tracker.observe({ at: '', type: 'thinking', data: {} }); // held
    t = 13_000;
    vi.advanceTimersByTime(10_000); // the window closes: the held record is written
    expect(writes).toHaveLength(3);
    t = 14_000;
    tracker.observe({ at: '', type: 'thinking', data: {} });
    t = 15_000;
    tracker.observe({ at: '', type: 'thinking', data: {} });
    expect(writes).toHaveLength(3);
    tracker.flush();
    expect(writes).toHaveLength(4);
    tracker.stop();
  });

  it('a write error never escapes', () => {
    const tracker = new ActivityTracker(() => {
      throw new Error('disk full');
    });
    expect(() => tracker.observe({ at: '', type: 'text', data: {} })).not.toThrow();
  });
});
