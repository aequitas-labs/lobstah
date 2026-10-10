import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicRenameSync, uniqueTempPath } from '../src/paths.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-atomic-rename-')); });
afterEach(() => { vi.restoreAllMocks(); removeTempDir(home); });

it.each(['EPERM', 'EBUSY', 'EACCES'])('all shared state publishers retry transient %s without rewriting their temp', (code) => {
  const file = path.join(home, 'state.json'); const tmp = uniqueTempPath(file);
  fs.writeFileSync(file, 'old'); fs.writeFileSync(tmp, 'new');
  const rename = fs.renameSync; let attempts = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    expect(source).toBe(tmp); expect(target).toBe(file);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('new');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    if (++attempts <= 2) throw Object.assign(new Error(code), { code });
    return rename(source, target);
  });
  atomicRenameSync(tmp, file);
  expect(attempts).toBe(3); expect(fs.readFileSync(file, 'utf8')).toBe('new');
  expect(fs.existsSync(tmp)).toBe(false);
});

it('persistent contention fails loudly after ten seconds without replacing the old state', () => {
  const file = path.join(home, 'state.json'); const tmp = uniqueTempPath(file);
  fs.writeFileSync(file, 'old'); fs.writeFileSync(tmp, 'new');
  let now = 0; let attempts = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
  const busy = Object.assign(new Error('file still busy'), { code: 'EBUSY' });
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { attempts++; throw busy; });
  expect(() => atomicRenameSync(tmp, file)).toThrow(busy);
  expect(now).toBe(11000); expect(attempts).toBe(10);
  expect(fs.readFileSync(file, 'utf8')).toBe('old'); expect(fs.readFileSync(tmp, 'utf8')).toBe('new');
});

it('does not retry a non-transient failure or create a fresh deadline for an enclosing lock', () => {
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('missing source'), { code: 'ENOENT' }); });
  expect(() => atomicRenameSync('missing', 'destination')).toThrow('missing source'); expect(rename).toHaveBeenCalledTimes(1);
  rename.mockClear().mockImplementation(() => { throw Object.assign(new Error('expired'), { code: 'EPERM' }); });
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  expect(() => atomicRenameSync('source', 'destination', 1000)).toThrow('expired'); expect(rename).toHaveBeenCalledTimes(1);
});
