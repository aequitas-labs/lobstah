import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, type Hash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;
/** Compress in members of about this size so memory stays bounded; gzip readers join concatenated members. */
const MEMBER = 4 * 1024 * 1024;
const READ = 1024 * 1024;

function octal(header: Buffer, offset: number, width: number, value: number): void {
  header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
}

/** Pax records carry what a ustar header cannot: long or non-ASCII names, large sizes. */
function paxBody(fields: Record<string, string>): Buffer {
  let text = '';
  for (const [key, value] of Object.entries(fields)) {
    const rest = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(rest) + 1;
    while (Buffer.byteLength(`${length}${rest}`) !== length) length = Buffer.byteLength(`${length}${rest}`);
    text += `${length}${rest}`;
  }
  return Buffer.from(text, 'utf8');
}

const fitsUstar = (value: string) => /^[\x20-\x7e]*$/.test(value) && value.length <= 100;
const MAX_OCTAL_SIZE = 0o77777777777;

function header(name: string, type: string, size: number, mode: number, mtime: number, linkname = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  octal(block, 100, 8, mode & 0o7777);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, Math.max(0, Math.floor(mtime)));
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'ascii');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

class TarGzWriter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Each gzip member's length on disk, so verification can read them back one at a time. */
  readonly members: number[] = [];
  readonly digest: Hash = createHash('sha256');

  constructor(private readonly fd: number) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.digest.update(chunk);
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= MEMBER) this.flush();
  }

  flush(): void {
    if (!this.pendingBytes) return;
    const member = gzipSync(Buffer.concat(this.pending, this.pendingBytes));
    fs.writeSync(this.fd, member);
    this.members.push(member.length);
    this.pending = [];
    this.pendingBytes = 0;
  }

  entry(name: string, type: string, size: number, mode: number, mtime: number, linkname = ''): void {
    const pax: Record<string, string> = {};
    if (!fitsUstar(name)) pax.path = name;
    if (linkname && !fitsUstar(linkname)) pax.linkpath = linkname;
    if (size > MAX_OCTAL_SIZE) pax.size = String(size);
    if (Object.keys(pax).length) {
      const body = paxBody(pax);
      this.push(header(`PaxHeader/${Buffer.from(name).subarray(-80).toString('latin1').replace(/[^\x20-\x7e]/g, '_')}`, 'x', body.length, 0o644, mtime));
      this.push(body);
      this.push(padding(body.length));
    }
    const short = (value: string) => (fitsUstar(value) ? value : Buffer.from(value).subarray(0, 100).toString('latin1').replace(/[^\x20-\x7e]/g, '_'));
    this.push(header(short(name), type, size > MAX_OCTAL_SIZE ? 0 : size, mode, mtime, linkname && short(linkname)));
  }

  file(name: string, source: string, stat: fs.Stats): void {
    this.entry(name, '0', stat.size, stat.mode, stat.mtimeMs / 1000);
    const fd = fs.openSync(source, 'r');
    try {
      let written = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(READ);
        const read = fs.readSync(fd, buffer, 0, READ, null);
        if (!read) break;
        written += read;
        if (written > stat.size) throw new Error(`File grew while archiving: ${source}`);
        this.push(buffer.subarray(0, read));
      }
      if (written !== stat.size) throw new Error(`File changed while archiving: ${source}`);
    } finally {
      fs.closeSync(fd);
    }
    this.push(padding(stat.size));
  }
}

/**
 * Write a gzip-compressed POSIX tar of `paths` (relative to `root`, directories
 * recursively) to `file`, then read it back and check every byte. Written in
 * Node so it works the same on Windows, where a shelled-out GNU tar reads a
 * drive letter as a remote host.
 */
export function writeTarGz(file: string, root: string, paths: readonly string[]): void {
  const fd = fs.openSync(file, 'w', 0o600);
  const writer = new TarGzWriter(fd);
  try {
    const seen = new Set<string>();
    const add = (relative: string) => {
      const name = relative.split(path.sep).join('/');
      if (seen.has(name)) return;
      seen.add(name);
      const source = path.join(root, relative);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) writer.entry(name, '2', 0, stat.mode, stat.mtimeMs / 1000, fs.readlinkSync(source));
      else if (stat.isDirectory()) {
        writer.entry(`${name}/`, '5', 0, stat.mode, stat.mtimeMs / 1000);
        for (const child of fs.readdirSync(source).sort()) add(path.join(relative, child));
      } else if (stat.isFile()) writer.file(name, source, stat);
    };
    for (const relative of paths) add(relative);
    writer.push(Buffer.alloc(BLOCK * 2));
    writer.flush();
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  verify(file, writer.members, writer.digest.digest('hex'));
}

/** Decompress each member back off disk and compare with what was written. */
function verify(file: string, members: readonly number[], expected: string): void {
  const digest = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    let position = 0;
    for (const length of members) {
      const member = Buffer.alloc(length);
      if (fs.readSync(fd, member, 0, length, position) !== length) throw new Error(`Archive is shorter than written: ${file}`);
      digest.update(gunzipSync(member));
      position += length;
    }
    if (position !== fs.fstatSync(fd).size) throw new Error(`Archive is longer than written: ${file}`);
  } finally {
    fs.closeSync(fd);
  }
  if (digest.digest('hex') !== expected) throw new Error(`Archive does not match what was written: ${file}`);
}
