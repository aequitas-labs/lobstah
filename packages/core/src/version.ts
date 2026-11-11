import * as fs from 'node:fs';

/**
 * The installed package version, read once when this module loads. The
 * published bundle lives at dist/main.js with package.json one level up;
 * anywhere that layout doesn't hold (running from source, tests) this reports
 * a dev placeholder rather than guessing.
 *
 * Once, not per call: `npm i -g lobstah` replaces package.json under a running
 * glass or daemon, and a process that re-read it would report the new version
 * while still running the old code. The stale-glass checks (glass status,
 * doctor, the daemon's refresh on start) compare these versions, so each
 * process must report the one it runs.
 */
function installedVersion(): string {
  // A compiled binary carries no package.json; the build stamps the version
  // in via `--define` instead.
  if (process.env.LOBSTAH_BUILD_VERSION) return process.env.LOBSTAH_BUILD_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (pkg.name === 'lobstah' && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0-dev';
}

const VERSION = installedVersion();

export function lobstahVersion(): string {
  return VERSION;
}
