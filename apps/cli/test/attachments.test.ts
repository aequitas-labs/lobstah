import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimNext, ensureLayout, laneDirs, queuedDescriptor, readMessageMeta, storedDescriptor, unhandled, unhandledTrapMessages } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const followUp = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-attachments-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

describe('CLI attachment lifecycle', () => {
  it('dispatch copies two files, catch and status surface them, follow-up and swap keep paths', () => {
    const png = path.join(home, 'tiny.png');
    const txt = path.join(home, 'brief.txt');
    fs.writeFileSync(png, Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(txt, 'the line');
    const dispatched = lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work', '--attach', png, '--attach', txt);
    expect(dispatched.status, dispatched.stdout).toBe(0);
    const attachments = queuedDescriptor(id, 'work')?.attachments;
    expect(attachments).toHaveLength(2);
    expect(attachments?.every((a) => a.path.startsWith(path.join(home, 'state', id, 'attachments')))).toBe(true);
    expect(lobstah('status', id).stdout).toContain('attachments: 2');
    expect(lobstah('catch', id).stdout).toContain('attachments[2]{name,type,bytes,path}');

    const fork = lobstah('dispatch', '--repo', 'r', '--id', followUp, '--brief-text', 'more', '--follow-up', id);
    expect(fork.status, fork.stdout).toBe(0);
    expect(queuedDescriptor(followUp, 'work')?.attachments).toEqual(attachments);

    claimNext('work');
    const swapped = lobstah('swap', id, '--harness', 'codex');
    expect(swapped.status, swapped.stdout).toBe(0);
    expect(storedDescriptor(id, 'work')?.attachments).toEqual(attachments);
  });

  it('invalid attached files are usage errors and do not enqueue', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nattachmentMaxBytes = 3\n');
    const big = path.join(home, 'big.txt');
    fs.writeFileSync(big, 'four');
    for (const file of [path.join(home, 'missing'), home, big]) {
      const res = lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work', '--attach', file);
      expect(res.status, res.stdout).toBe(2);
      expect(res.stdout).toContain('error:');
      expect(queuedDescriptor(id, 'work')).toBeUndefined();
    }
  });

  it('send copies files, puts the block in the message, and records attachments in the sidecar and glass', () => {
    const source = path.join(home, 'note.txt');
    fs.writeFileSync(source, 'second line');
    expect(lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work').status).toBe(0);
    const sent = lobstah('send', id, 'read this', '--attach', source);
    expect(sent.status, sent.stdout).toBe(0);
    const message = unhandled(id, 'work')[0]!;
    const meta = readMessageMeta(id, 'work', message.file)!;
    expect(meta.from).toBe('terminal');
    expect(meta.attachments).toHaveLength(1);
    expect(message.text).toContain('--- ATTACHMENTS ---');
    expect(message.text).toContain('note.txt (text/plain, 11 bytes) at ');
    expect(buildGlassSnapshot().dispatches.find((d) => d.id === id)?.messageAttachments).toEqual(meta.attachments);
    expect(fs.readFileSync(meta.attachments![0]!.path, 'utf8')).toBe('second line');
  });

  it('accepts an attachment-only message', () => {
    const source = path.join(home, 'only.txt');
    fs.writeFileSync(source, 'contents');
    expect(lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work').status).toBe(0);
    const sent = lobstah('send', id, '--attach', source);
    expect(sent.status, sent.stdout).toBe(0);
    expect(unhandled(id, 'work')[0]?.text).toContain('[from terminal]\n--- ATTACHMENTS ---');
  });

  it('trap messages retain attachment metadata without changing the envelope format', () => {
    const source = path.join(home, 'reply.txt');
    fs.writeFileSync(source, 'hello');
    fs.writeFileSync(path.join(home, 'soaking', 'seat.json'), JSON.stringify({
      trapId: 'seat', worktree: home, cwd: home, repo: 'r', harness: 'codex', sessionId: 's',
      signedOnAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), firstParkedAt: new Date().toISOString(),
    }));
    const sent = lobstah('send', 'wt:seat', 'see file', '--attach', source);
    expect(sent.status, sent.stdout).toBe(0);
    const message = unhandledTrapMessages('seat')[0]!;
    expect(message.text).toContain('--- ATTACHMENTS ---');
    expect(message.attachments?.[0]?.path).toContain(path.join('inbox', 'trap-seat', 'attachments'));
    const trap = buildGlassSnapshot().traps.find((t) => t.trapId === 'seat');
    expect(trap?.messages[0]?.attachments).toEqual(message.attachments);
    expect(fs.existsSync(path.join(laneDirs('work').inbox, 'trap-seat', '001.meta.json'))).toBe(true);
  });
});
