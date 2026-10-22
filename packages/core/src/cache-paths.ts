import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDirLock } from './dir-lock.js';
import { lobstahHome } from './paths.js';
const heldCacheLocks = new Set<string>();

/** Accept only worktree-relative globs; Windows paths and traversal are unsafe on every host. */
export function validCacheGlob(pattern: string): boolean {
  return pattern.length > 0 && !/[\\\0:]/.test(pattern) && !path.posix.isAbsolute(pattern) &&
    !pattern.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
}

/** Serialize cache removal with a trap's claims and status transitions. */
export function withTrapCacheLock<T>(trapId: string, action: () => T): T {
  if (heldCacheLocks.has(trapId)) return action(); // A claim writes its initial working status under the same lock.
  const dir = path.join(lobstahHome(), 'cache-locks');
  fs.mkdirSync(dir, { recursive: true });
  return withDirLock(path.join(dir, `trap-${encodeURIComponent(trapId)}`), () => {
    heldCacheLocks.add(trapId);
    try { return action(); } finally { heldCacheLocks.delete(trapId); }
  }, {
    staleMs: 5000, waitMs: 5000, busy: () => new Error(`trap ${trapId} cache cleanup is busy; try again`),
  });
}

function segmentPattern(segment: string): RegExp {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[' && segment.indexOf(']', i + 1) > i + 1) {
      const end = segment.indexOf(']', i + 1);
      const group = segment.slice(i + 1, end).replace(/^!/, '^');
      source += `[${group.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Expand directories without following any symlink or entering Git metadata, including through **. */
export function cacheDirectories(root: string, patterns: readonly string[]): string[] {
  const matches = new Set<string>();
  const walk = (dir: string, parts: string[], index: number): void => {
    if (index === parts.length) { if (dir !== root) matches.add(dir); return; }
    const part = parts[index]!;
    if (part === '**') walk(dir, parts, index + 1);
    const matcher = segmentPattern(part);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.toLowerCase() === '.git') continue;
      const child = path.join(dir, entry.name);
      if (part === '**') walk(child, parts, index);
      else if (matcher.test(entry.name)) walk(child, parts, index + 1);
    }
  };
  for (const pattern of patterns) {
    if (!validCacheGlob(pattern)) continue;
    walk(root, pattern.split('/'), 0);
  }
  // An overlapping glob must not count or delete a child a second time.
  return [...matches].sort().filter((dir, _i, dirs) => !dirs.some((parent) => dir !== parent && dir.startsWith(parent + path.sep)));
}
