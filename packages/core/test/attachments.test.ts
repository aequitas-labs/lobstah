import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AttachmentError,
  attachmentBlock,
  copyAttachments,
  dispatchAttachmentsDir,
  enqueue,
  ensureLayout,
  queuedDescriptor,
} from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-attachments-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('dispatch attachments', () => {
  it('copies one or two files into owned state with descriptor metadata', () => {
    const png = path.join(home, 'pixel.png');
    const txt = path.join(home, 'notes.txt');
    fs.writeFileSync(png, Buffer.from([1, 2, 3]));
    fs.writeFileSync(txt, 'first line\n');
    const attachments = copyAttachments([png, txt], dispatchAttachmentsDir('d1', 'work'), 25 * 1024 * 1024);
    enqueue({ id: 'd1', repo: 'r', brief: 'b', attachments });
    fs.rmSync(png);
    fs.rmSync(txt);

    expect(queuedDescriptor('d1', 'work')?.attachments).toEqual(attachments);
    expect(attachments.map(({ name, bytes, type }) => ({ name, bytes, type }))).toEqual([
      { name: 'pixel.png', bytes: 3, type: 'image/png' },
      { name: 'notes.txt', bytes: 11, type: 'text/plain' },
    ]);
    expect(fs.readFileSync(attachments[0]!.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(fs.readFileSync(attachments[1]!.path, 'utf8')).toBe('first line\n');
    expect(fs.lstatSync(attachments[0]!.path).isSymbolicLink()).toBe(false);
    expect(attachmentBlock(attachments)).toContain('pixel.png (image/png, 3 bytes) at ');
  });

  it('suffixes colliding basenames without overwriting', () => {
    fs.mkdirSync(path.join(home, 'a'));
    fs.mkdirSync(path.join(home, 'b'));
    const first = path.join(home, 'a', 'same.txt');
    const second = path.join(home, 'b', 'same.txt');
    fs.writeFileSync(first, 'a');
    fs.writeFileSync(second, 'b');
    const attachments = copyAttachments([first, second], dispatchAttachmentsDir('d1', 'work'), 100);
    expect(attachments.map((a) => a.name)).toEqual(['same.txt', 'same-2.txt']);
    expect(attachments.map((a) => fs.readFileSync(a.path, 'utf8'))).toEqual(['a', 'b']);
  });

  it('rejects missing, non-regular, and oversized files before copying', () => {
    const good = path.join(home, 'good.txt');
    const big = path.join(home, 'big.txt');
    fs.writeFileSync(good, 'yes');
    fs.writeFileSync(big, 'too large');
    const dir = dispatchAttachmentsDir('d1', 'work');
    expect(() => copyAttachments([good, path.join(home, 'missing')], dir, 100)).toThrow(AttachmentError);
    expect(() => copyAttachments([home], dir, 100)).toThrow(/not a regular file/);
    const directoryLink = path.join(home, 'directory-link');
    fs.symlinkSync(home, directoryLink);
    expect(() => copyAttachments([directoryLink], dir, 100)).toThrow(/not a regular file/);
    expect(() => copyAttachments([good, big], dir, 3)).toThrow(/exceeds 3 bytes/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reuses origin paths for a follow-up rather than copying again', () => {
    const file = path.join(home, 'spec.pdf');
    fs.writeFileSync(file, 'PDF');
    const attachments = copyAttachments([file], dispatchAttachmentsDir('d1', 'work'), 100);
    enqueue({ id: 'd1', repo: 'r', brief: 'first', attachments });
    enqueue({ id: 'd2', repo: 'r', brief: 'next', followUp: 'd1' });
    expect(queuedDescriptor('d2', 'work')?.attachments).toEqual(attachments);
    expect(fs.existsSync(dispatchAttachmentsDir('d2', 'work'))).toBe(false);
  });
});
