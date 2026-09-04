import * as fs from 'node:fs';

/**
 * The installed package version. The published bundle lives at dist/main.js
 * with package.json one level up; anywhere that layout doesn't hold (running
 * from source, tests) this reports a dev placeholder rather than guessing.
 */
export function lobstahVersion(): string {
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
