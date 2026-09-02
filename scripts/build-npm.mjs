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

const external = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'];
const common = [
  '--bundle', '--platform=node', '--format=esm', '--target=node20',
  ...external.map((e) => `--external:${e}`),
];
execFileSync('npx', ['esbuild', 'apps/cli/src/main.ts', ...common, `--outfile=${out}/dist/main.js`], { cwd: root, stdio: 'inherit' });
execFileSync('npx', ['esbuild', 'packages/runner/src/index.ts', ...common, `--outfile=${out}/dist/runner.js`], { cwd: root, stdio: 'inherit' });

const version = process.argv[2] ?? '0.1.0';
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
      files: ['dist', 'README.md', 'LICENSE'],
      engines: { node: '>=20' },
      keywords: ['agents', 'claude-code', 'codex', 'supervisor', 'coding-agents', 'worktree', 'orchestration'],
      repository: { type: 'git', url: 'git+https://github.com/aequitas-labs/lobstah.git' },
      optionalDependencies: {
        '@anthropic-ai/claude-agent-sdk': '^0.3.0',
        '@openai/codex-sdk': '^0.152.0',
      },
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
fs.chmodSync(path.join(out, 'dist', 'main.js'), 0o755);
console.log(`built ${out} @ ${version}`);
