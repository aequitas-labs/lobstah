import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lobstahHome, atomicRenameSync, uniqueTempPath } from './paths.js';

export interface RecordArchive {
  key: string;
  bundle: string;
  archivedAt: string;
  paths: string[];
}

function indexFile(key: string): string {
  return path.join(lobstahHome(), 'archive', 'index', `${createHash('sha256').update(key).digest('hex')}.json`);
}

/** Small receipts let threads identify archived work without opening compressed history. */
export function readRecordArchive(key: string): RecordArchive | undefined {
  try {
    const receipt = JSON.parse(fs.readFileSync(indexFile(key), 'utf8')) as RecordArchive;
    return receipt.key === key && fs.existsSync(path.join(lobstahHome(), 'archive', receipt.bundle)) ? receipt : undefined;
  } catch { return undefined; }
}

/** Save and verify a portable bundle before the caller removes any source files. Failure keeps the sources. */
export function archiveRecords(keys: readonly string[], targets: readonly string[]): RecordArchive | undefined {
  const home = lobstahHome();
  const paths = [...new Set(targets.filter((target) => {
    try { fs.lstatSync(target); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }).map((target) => {
    const relative = path.relative(home, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Archive target is outside lobstah home: ${target}`);
    return relative;
  }))];
  if (!paths.length) return undefined;
  const root = path.join(home, 'archive');
  fs.mkdirSync(path.join(root, 'index'), { recursive: true, mode: 0o700 });
  const bundle = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.tar.gz`;
  const file = path.join(root, bundle);
  const temporary = uniqueTempPath(file);
  const list = `${temporary}.paths`;
  try {
    fs.writeFileSync(temporary, '', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(list, `${paths.map((p) => p.split(path.sep).join('/')).join('\0')}\0`, { mode: 0o600, flag: 'wx' });
    execFileSync('tar', ['-czf', temporary, '-C', home, '--null', '-T', list], { stdio: 'pipe' });
    fs.chmodSync(temporary, 0o600);
    execFileSync('tar', ['-tzf', temporary], { stdio: 'ignore' });
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    atomicRenameSync(temporary, file);
    const archivedAt = new Date().toISOString();
    for (const key of keys) {
      const receipt: RecordArchive = { key, bundle, archivedAt, paths };
      const index = indexFile(key);
      const tempIndex = uniqueTempPath(index);
      fs.writeFileSync(tempIndex, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      atomicRenameSync(tempIndex, index);
    }
    return { key: keys[0] ?? '', bundle, archivedAt, paths };
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.rmSync(list, { force: true });
  }
}
