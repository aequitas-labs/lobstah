import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acknowledge,
  acknowledgeTrapMessage,
  answeredAt,
  bounceTrapMessages,
  ensureLayout,
  listNotices,
  readMessageMeta,
  sendMessage,
  sendTrapMessage,
  unhandled,
  unhandledTrapMessages,
} from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('inbox', () => {
  it('sequences messages and drains in order', () => {
    sendMessage('i1', 'work', 'first');
    sendMessage('i1', 'work', 'second');
    expect(unhandled('i1', 'work').map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('acknowledgement is a rename that cannot be faked', () => {
    const name = sendMessage('i2', 'work', 'hello');
    acknowledge('i2', 'work', name);
    expect(unhandled('i2', 'work')).toEqual([]);
    expect(fs.existsSync(path.join(home, 'inbox', 'i2', 'handled', name))).toBe(true);
  });

  it('sequence numbers keep rising after acknowledgement', () => {
    const a = sendMessage('i3', 'work', 'one');
    acknowledge('i3', 'work', a);
    const b = sendMessage('i3', 'work', 'two');
    expect(b > a).toBe(true);
  });

  it('moves the attachment sidecar with its message', () => {
    const attachment = { name: 'a.txt', path: '/tmp/owned/a.txt', bytes: 1, type: 'text/plain' };
    const name = sendMessage('i4', 'work', 'see file', 'helm', [attachment]);
    expect(readMessageMeta('i4', 'work', name)?.attachments).toEqual([attachment]);
    acknowledge('i4', 'work', name);
    expect(readMessageMeta('i4', 'work', name)).toBeUndefined();
    expect(readMessageMeta('i4', 'work', name, true)?.attachments).toEqual([attachment]);
  });

  it('uses the attachment sidecar as the answer provenance without a second writer', () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    const attachment = { name: 'answer.txt', path: '/tmp/owned/answer.txt', bytes: 2, type: 'text/plain' };
    const name = sendMessage('i5', 'work', 'see answer', 'helm', [attachment]);
    const meta = readMessageMeta('i5', 'work', name)!;
    expect(meta).toMatchObject({ from: 'helm', attachments: [attachment] });
    expect(answeredAt('i5', 'work', since)).toBe(meta.at);
    acknowledge('i5', 'work', name);
    expect(answeredAt('i5', 'work', since)).toBe(meta.at);
  });
});

describe('trap inbox', () => {
  it('messages carry provenance and drain in order', () => {
    sendTrapMessage('ab12cd34', 'helm', 'scaffold sounds good');
    sendTrapMessage('ab12cd34', 'session:79f1efc5', 'fyi only');
    const msgs = unhandledTrapMessages('ab12cd34');
    expect(msgs.map((m) => [m.from, m.text])).toEqual([
      ['helm', 'scaffold sounds good'],
      ['session:79f1efc5', 'fyi only'],
    ]);
    acknowledgeTrapMessage('ab12cd34', msgs[0]!.file);
    expect(unhandledTrapMessages('ab12cd34')).toHaveLength(1);
  });

  it('bounces undelivered mail to the helm as notices, never to the next holder', () => {
    sendTrapMessage('dead0001', 'helm', 'undelivered steering');
    expect(bounceTrapMessages('dead0001')).toBe(1);
    expect(unhandledTrapMessages('dead0001')).toEqual([]);
    const bounced = listNotices().filter((n) => n.kind === 'message-bounced');
    expect(bounced).toHaveLength(1);
    expect(bounced[0]!.text).toContain('undelivered steering');
  });
});
