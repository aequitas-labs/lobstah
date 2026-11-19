import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { WatchSnapshot } from '@lobstah/watch-types';
import { atomicRenameSync, lobstahHome, readDirIfPresent, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';

/** One atomic snapshot commits observations, cursor and delivery receipts together. */
export class WatchJournal {
  constructor(readonly directory = path.join(lobstahHome(), 'watch-journal')) {}

  /** Hash the complete key: punctuation normalization must never alias two sources. */
  private file(key: string): string {
    return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  read(key: string): WatchSnapshot | undefined {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.file(key), 'utf8')) as WatchSnapshot;
      if (snapshot.key !== key) throw new Error('Watch journal key mismatch');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  list(): WatchSnapshot[] {
    return readDirIfPresent(this.directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const snapshot = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8')) as WatchSnapshot;
        if (path.basename(this.file(snapshot.key)) !== file) throw new Error('Watch journal key mismatch');
        return snapshot;
      });
  }

  /** Never hold this short publication lock while calling external code. */
  update<T>(key: string, change: (snapshot: WatchSnapshot | undefined) => { snapshot?: WatchSnapshot; result: T }): T {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(key);
    return withDirLock(
      `${file}.lock`,
      () => {
        const previous = this.read(key),
          oldVersion = previous?.type.stateVersion,
          oldType = previous?.type.id;
        const oldIdentity = previous ? `${previous.type.id}:${previous.generation}` : '';
        const { snapshot, result } = change(previous);
        if (snapshot) {
          if (snapshot.key !== key) throw new Error('Watch journal key cannot change');
          if (oldVersion !== undefined && (oldVersion !== snapshot.type.stateVersion || oldType !== snapshot.type.id)) {
            if (!Number.isSafeInteger(oldVersion) || oldVersion < 1) throw new Error('Invalid stored watch state version');
            const backup = `${file}.state-${oldVersion}-${createHash('sha256').update(oldIdentity).digest('hex').slice(0, 16)}.bak`;
            let backupFd: number | undefined;
            try {
              backupFd = fs.openSync(backup, 'wx', 0o600);
              fs.writeFileSync(backupFd, fs.readFileSync(file));
              fs.fsyncSync(backupFd);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            } finally {
              if (backupFd !== undefined) fs.closeSync(backupFd);
            }
          }
          const temporary = uniqueTempPath(file);
          try {
            const fd = fs.openSync(temporary, 'wx', 0o600);
            try {
              fs.writeFileSync(fd, JSON.stringify(snapshot));
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            atomicRenameSync(temporary, file);
          } finally {
            fs.rmSync(temporary, { force: true });
          }
        }
        return result;
      },
      { staleMs: 120_000, waitMs: 10_000, busy: () => new Error(`Watch journal is busy: ${key}`) },
    );
  }
}
