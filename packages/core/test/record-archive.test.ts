import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { archiveRecords, readRecordArchive } from '../src/record-archive.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-archive-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('writes an extractable bundle with binary files, nested directories and private receipts', () => {
  const record = path.join(home, 'state', 'd1');
  fs.mkdirSync(path.join(record, 'attachments'), { recursive: true });
  const bytes = Buffer.from([0, 255, 17, 10, 0]);
  fs.writeFileSync(path.join(record, 'attachments', 'file with spaces'), bytes);
  const archived = archiveRecords(['work:d1', 'report:work:d1'], [record])!;
  expect(readRecordArchive('work:d1')).toEqual(archived);
  expect(readRecordArchive('report:work:d1')?.bundle).toBe(archived.bundle);
  const bundle = path.join(home, 'archive', archived.bundle);
  if (process.platform !== 'win32') expect(fs.statSync(bundle).mode & 0o777).toBe(0o600);
  const staging = path.join(home, 'staging');
  fs.mkdirSync(staging);
  execFileSync('tar', ['-xzf', bundle, '-C', staging]);
  expect(fs.readFileSync(path.join(staging, 'state', 'd1', 'attachments', 'file with spaces'))).toEqual(bytes);
  expect(fs.existsSync(record)).toBe(true); // Only the caller may remove the sources.
  fs.rmSync(bundle);
  expect(readRecordArchive('work:d1')).toBeUndefined();
});

it('rejects paths outside home before writing or removing anything', () => {
  expect(() => archiveRecords(['bad'], [path.dirname(home)])).toThrow('outside lobstah home');
  expect(fs.existsSync(path.join(home, 'archive'))).toBe(false);
});
