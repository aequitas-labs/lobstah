import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLayout, enqueue, claimNext, appendStatus, reconcileAssistance, fileReport, dispatchReportKey, readMessageMeta, unhandled, acknowledge, requestCancel, pendingIds, listNotices, type Descriptor } from '../src/index.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-assistance-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.app]\npath="/unused"\ntrunk="main"\n[grounds.studio]\nrepos=["app"]\n[traps.desk]\nharness="claude"\nsurface="claude-desktop"\ngrounds="studio"\n');
  enqueue({ id: 'parent', repo: 'app', brief: 'Original task' }); claimNext('work'); appendStatus('parent', 'work', 'paused', 'Waiting for inspection', undefined, { waitingOn: 'external' });
});
afterEach(() => { delete process.env.LOBSTAH_HOME; fs.rmSync(home, { recursive: true, force: true }); });
function child(overrides: Partial<Descriptor> = {}): Descriptor { return { id: 'child', for: 'trap:desk', brief: 'Inspect the window', target: { kind: 'configured-trap', profile: 'desk', grounds: 'studio', surface: 'claude-desktop', parentDispatch: 'parent' }, ...overrides }; }

it('delivers the terminal child result once to its paused parent, including a retry after its receipt is lost', () => {
  enqueue(child()); claimNext('work');
  const findings = path.join(home, 'findings.md'), image = path.join(home, 'screenshot.png');
  fs.writeFileSync(findings, '# Findings\nThe window is correct\n'); fs.writeFileSync(image, 'test-image');
  fileReport({ key: dispatchReportKey('child', 'work'), file: findings, attach: [image], fallbackTitle: 'Findings', author: 'desk', maxBytes: 10000, dispatch: 'child', lane: 'work' });
  appendStatus('child', 'work', 'done', 'The window is correct');
  expect(unhandled('parent', 'work')).toHaveLength(1);
  expect(unhandled('parent', 'work')[0]?.text).toContain('The window is correct');
  const file = unhandled('parent', 'work')[0]!.file;
  expect(readMessageMeta('parent', 'work', file)?.attachments?.[0]?.name).toBe('screenshot.png');
  acknowledge('parent', 'work', file);
  const outbox = path.join(home, 'assistance', 'child.json'); const delivery = JSON.parse(fs.readFileSync(outbox, 'utf8')); delivery.state = 'waiting'; fs.writeFileSync(outbox, JSON.stringify(delivery));
  reconcileAssistance(); reconcileAssistance();
  expect(unhandled('parent', 'work')).toHaveLength(0);
  expect(fs.readdirSync(path.join(home, 'inbox', 'parent', 'handled')).filter((name) => name.endsWith('.msg'))).toHaveLength(1);
});

it('refuses another grounds and an ended parent before queuing assistance', () => {
  expect(() => enqueue(child({ target: { ...child().target!, grounds: 'elsewhere' } }))).toThrow(/another grounds/);
  appendStatus('parent', 'work', 'done', 'Already finished');
  expect(() => enqueue(child())).toThrow(/already ended/);
  expect(pendingIds('work')).toEqual([]);
});

it('cancels queued children when the parent ends, and retains a late active result without reopening the parent', () => {
  enqueue(child()); appendStatus('parent', 'work', 'done', 'Finished another way');
  expect(pendingIds('work')).toEqual([]);
  expect(unhandled('parent', 'work')).toEqual([]);
  expect(listNotices(100).some((notice) => notice.kind === 'assistance-result')).toBe(false);
});

it('requests an active child to stop when its parent is cancelled, then keeps the late failure for the helm', () => {
  enqueue(child()); claimNext('work'); requestCancel('parent', 'work'); reconcileAssistance();
  expect(fs.existsSync(path.join(home, 'active', 'child', 'cancel'))).toBe(true);
  appendStatus('child', 'work', 'failed', 'Stopped after cancellation');
  expect(unhandled('parent', 'work')).toEqual([]);
  expect(listNotices(100).filter((notice) => notice.kind === 'assistance-result')).toHaveLength(1);
});
