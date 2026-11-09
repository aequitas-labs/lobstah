import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { removeTempDir } from '../../../test/temp-dir.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) removeTempDir(dir);
  dir = undefined;
});

/**
 * The glass that served 0.8.5's page for days after `npm i -g lobstah@0.8.6`:
 * it re-read package.json on every call, so it reported 0.8.6, and every
 * stale-glass check (glass status, doctor, the daemon's refresh on start)
 * saw nothing to restart.
 */
it('a running process keeps reporting the version it started with after an upgrade replaces package.json', async () => {
  // The published layout: dist/version.js with the package's package.json one level up.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-version-'));
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.copyFileSync(new URL('../dist/version.js', import.meta.url), path.join(dir, 'dist', 'version.js'));
  const pkg = (version: string) => fs.writeFileSync(path.join(dir!, 'package.json'), JSON.stringify({ name: 'lobstah', version }));
  pkg('0.8.5');

  const saved = process.env.LOBSTAH_BUILD_VERSION;
  delete process.env.LOBSTAH_BUILD_VERSION;
  try {
    const { lobstahVersion } = (await import(pathToFileURL(path.join(dir, 'dist', 'version.js')).href)) as { lobstahVersion: () => string };
    expect(lobstahVersion()).toBe('0.8.5');
    pkg('0.8.6');
    expect(lobstahVersion()).toBe('0.8.5');
  } finally {
    if (saved !== undefined) process.env.LOBSTAH_BUILD_VERSION = saved;
  }
});
