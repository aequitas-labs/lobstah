import * as fs from 'node:fs';
import { COMPILED_BINARY } from '@lobstah/core';

const shq = (s: string) => (process.platform === 'win32' ? `"${s.replaceAll('"', '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/** How this process re-invokes itself from a shell — node layout or compiled binary. */
export function watchSelfCommand(): string {
  if (COMPILED_BINARY) return shq(process.execPath);
  const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : 'lobstah';
  return `${shq(process.execPath)} ${shq(entry)}`;
}
