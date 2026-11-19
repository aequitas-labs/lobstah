// Build the publishable `lobstah` package: two esbuild bundles (CLI+daemon,
// runner) with workspace packages inlined, harness SDKs left external as
// optional dependencies.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'build', 'npm');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dist'), { recursive: true });

const external = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', 'ws'];
const common = [
  '--bundle', '--platform=node', '--format=esm', '--target=node20',
  '--banner:js=import { createRequire as pluginCreateRequire } from "node:module"; const require = pluginCreateRequire(import.meta.url);',
  ...external.map((e) => `--external:${e}`),
];
execFileSync('npx', ['esbuild', 'apps/cli/src/main.ts', ...common, `--outfile=${out}/dist/main.js`], { cwd: root, stdio: 'inherit' });
execFileSync('npx', ['esbuild', 'packages/runner/src/index.ts', ...common, `--outfile=${out}/dist/runner.js`], { cwd: root, stdio: 'inherit' });
execFileSync('npx', ['esbuild', 'apps/cli/src/wharf-trap-runner.ts', ...common, `--outfile=${out}/dist/wharf-trap-runner.js`], { cwd: root, stdio: 'inherit' });
execFileSync('npx', ['esbuild', 'packages/watch-types/src/plugin-worker.ts', ...common, `--outfile=${out}/dist/plugin-worker.js`], { cwd: root, stdio: 'inherit' });
// Publish the generic kernel and optional adapter entry points independently.
const watchTypePackage = JSON.parse(fs.readFileSync(path.join(root, 'packages/watch-types/package.json'), 'utf8'));
const watchTypeExports = {};
for (const [subpath, entry] of Object.entries(watchTypePackage.exports)) {
  const suffix = subpath === '.' ? '' : `/${subpath.slice(2)}`;
  const source = `packages/watch-types/src/${entry.import.slice('./dist/'.length).replace(/\.js$/, '.ts')}`;
  const bundle = `dist/watch-types${suffix}.js`;
  fs.mkdirSync(path.dirname(path.join(out, bundle)), { recursive: true });
  const flags = entry.browser ? ['--bundle', '--platform=neutral', '--format=esm', '--target=es2020'] : common;
  execFileSync('npx', ['esbuild', source, ...flags, `--outfile=${out}/${bundle}`], { cwd: root, stdio: 'inherit' });
  watchTypeExports[`./watch-types${suffix}`] = {
    types: entry.types.replace('./dist/', './dist/watch-types/'),
    ...(entry.browser ? { browser: `./${bundle}` } : {}),
    import: `./${bundle}`,
  };
}
// Keep declaration-relative imports intact for external TypeScript adapter authors.
fs.cpSync(path.join(root, 'packages/watch-types/dist'), path.join(out, 'dist/watch-types'), { recursive: true, filter: (file) => fs.statSync(file).isDirectory() || file.endsWith('.d.ts') });


// Default to the CLI's version: every published artifact carries one version.
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8')).version;
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'lobstah',
      version,
      description: 'Harness-agnostic, token-efficient supervision framework for coding agents',
      license: 'MIT',
      author: 'aequitas labs LLC',
      type: 'module',
      bin: { lobstah: 'dist/main.js' },
      exports: { ...watchTypeExports, './dist/*': './dist/*', './package.json': './package.json' },
      files: ['dist', 'docs', 'pet', 'README.md', 'LICENSE'],
      engines: { node: '>=20' },
      keywords: ['agents', 'claude-code', 'codex', 'supervisor', 'coding-agents', 'worktree', 'orchestration'],
      repository: { type: 'git', url: 'git+https://github.com/aequitas-labs/lobstah.git' },
      optionalDependencies: {
        '@anthropic-ai/claude-agent-sdk': '^0.3.0',
        '@openai/codex-sdk': '^0.152.0',
      },
      dependencies: { ws: JSON.parse(fs.readFileSync(path.join(root, 'apps/cli/package.json'), 'utf8')).dependencies.ws },
    },
    null,
    2,
  ),
);
const readme = fs
  .readFileSync(path.join(root, 'README.md'), 'utf8')
  .replaceAll('](docs/', '](https://github.com/aequitas-labs/lobstah/blob/main/docs/')
  .replaceAll('](LICENSE)', '](https://github.com/aequitas-labs/lobstah/blob/main/LICENSE)');
fs.writeFileSync(path.join(out, 'README.md'), readme);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
// `lobstah init` points at docs/configuration.md — ship the docs so the
// reference resolves on an installed copy, not just in the repo.
fs.cpSync(path.join(root, 'docs'), path.join(out, 'docs'), { recursive: true });
// `lobstah pet install` builds the desktop pet from these sources, so an
// installed lobstah gets the pet of its own version. Tests ship too: the
// manifest names the test target, and SwiftPM refuses a missing target path.
for (const part of ['Package.swift', 'Sources', 'Tests']) {
  fs.cpSync(path.join(root, 'apps/pet', part), path.join(out, 'pet', part), { recursive: true });
}
fs.chmodSync(path.join(out, 'dist', 'main.js'), 0o755);
console.log(`built ${out} @ ${version}`);
