import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect } from 'vitest';

/**
 * A test that spawns apps/cli/dist/main.js, or imports a workspace package
 * (which resolves to that package's dist), runs the last build, not the
 * checkout. After a pull or a branch switch without `pnpm build` it fails on
 * behaviour the source already has, which reads as a regression. Fail those
 * files up front instead, naming the stale package and the newer source file.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

/** The extra source trees a package's build reads besides its own src. */
const extraInputs: Record<string, string[]> = {
  'apps/cli': ['apps/cli/glass', 'packages/glass-ui/ui'],
};

function newest(dir: string): { file: string; mtimeMs: number } | undefined {
  let best: { file: string; mtimeMs: number } | undefined;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else {
        const { mtimeMs } = fs.statSync(full);
        if (!best || mtimeMs > best.mtimeMs) best = { file: full, mtimeMs };
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return best;
}

interface Pkg {
  dir: string;
  main: string;
}

/** The workspace packages tsc builds, each with the entry file its importers load. */
function builtPackages(): Pkg[] {
  return ['apps', 'packages'].flatMap((group) => fs.readdirSync(path.join(root, group)).flatMap((name) => {
    const dir = `${group}/${name}`;
    let manifest: { main?: string; scripts?: { build?: string } };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    } catch {
      return [];
    }
    return manifest.main && manifest.scripts?.build?.includes('tsc') ? [{ dir, main: manifest.main }] : [];
  }));
}

export function staleBuild(): string | undefined {
  for (const { dir, main } of builtPackages()) {
    // tsc rewrites every output on each build, so the entry file's mtime is the build's.
    let built: number;
    try {
      built = fs.statSync(path.join(root, dir, main)).mtimeMs;
    } catch {
      return `${dir} has no build. Run \`pnpm build\`, then run the tests again.`;
    }
    for (const input of [`${dir}/src`, ...(extraInputs[dir] ?? [])]) {
      const source = newest(path.join(root, input));
      if (source && source.mtimeMs > built) {
        const file = path.relative(root, source.file).split(path.sep).join('/');
        return `${dir}/dist is older than ${file}, so this test would run the last build instead of the checkout. Run \`pnpm build\`, then run the tests again.`;
      }
    }
  }
  return undefined;
}

let checked: string | undefined | null = null;

beforeAll(() => {
  const testPath = expect.getState().testPath;
  if (!testPath) return;
  const text = fs.readFileSync(testPath, 'utf8');
  if (!/dist\/main\.js|from '@lobstah\//.test(text)) return;
  if (checked === null) checked = staleBuild();
  if (checked) throw new Error(checked);
});
