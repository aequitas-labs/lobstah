import fs from 'node:fs';
import path from 'node:path';
import type { WatchTypeDescriptor } from '@lobstah/watch-types';
import { atomicRenameSync, lobstahHome, readDirIfPresent, uniqueTempPath } from './paths.js';

/** Installed source metadata makes kind validation independent of a source union. */
export function storeWatchTypeDescriptor(descriptor: WatchTypeDescriptor): void {
  if (!/^[a-z][a-z0-9.-]*$/.test(descriptor.id)) throw new Error('Invalid watch type ID');
  const directory = path.join(lobstahHome(), 'watch-types');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${descriptor.id}.json`),
    data = JSON.stringify(descriptor);
  try {
    if (fs.readFileSync(file, 'utf8') === data) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = uniqueTempPath(file);
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    atomicRenameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A corrupt manifest contributes no kinds; its watch is still shown with its error. */
export function storedWatchTypeDescriptors(): WatchTypeDescriptor[] {
  const directory = path.join(lobstahHome(), 'watch-types');
  return readDirIfPresent(directory)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      try {
        const descriptor = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as WatchTypeDescriptor;
        if (
          `${descriptor.id}.json` !== file ||
          descriptor.apiVersion !== 1 ||
          (descriptor.attentionKinds !== undefined && !Array.isArray(descriptor.attentionKinds))
        )
          return [];
        descriptor.attentionKinds ??= [];
        if (
          descriptor.attentionKinds.some(
            (kind) => typeof kind.kind !== 'string' || typeof kind.label !== 'string' || typeof kind.defaultEnabled !== 'boolean',
          )
        )
          return [];
        return [descriptor];
      } catch {
        return [];
      }
    });
}
