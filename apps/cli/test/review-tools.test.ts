import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { reviewTools } from '../src/review-tools.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeTempDir));
describe('repo review settings', () => {
  it('matches configured SSH and HTTPS origins, not the local alias', () => {
    expect(reviewTools({ repos: {
      alias: { path: '/missing', origin: 'git@github.com:Acme/web.git', trunk: 'main', reviewTool: 'linear' },
      second: { path: '/missing', origin: 'https://github.com/acme/api.git', trunk: 'main', reviewTool: 'graphite' },
    } })).toEqual({ 'acme/web': 'linear', 'acme/api': 'graphite' });
  });
  it('resolves path-only repos once per cache window and refreshes after it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-')); dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args]);
    git('init'); git('remote', 'add', 'origin', 'https://github.com/acme/web.git');
    const cfg = { repos: { alias: { path: dir, trunk: 'main', reviewTool: 'linear' } } };
    expect(reviewTools(cfg, 1000)).toEqual({ 'acme/web': 'linear' });
    git('remote', 'set-url', 'origin', 'git@github.com:acme/other.git');
    expect(reviewTools(cfg, 2000)).toEqual({ 'acme/web': 'linear' });
    expect(reviewTools(cfg, 62_000)).toEqual({ 'acme/other': 'linear' });
  });
});
