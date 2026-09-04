// Build standalone binaries via `bun build --compile` — the no-Node install
// channel, attached to each GitHub release. The harness SDKs stay external:
// inside a binary their import fails and both adapters fall back to driving
// the harness CLIs directly (codex fully Node-free; claude needs the claude
// CLI on the host). The daemon re-execs the binary itself with the hidden
// __runner verb, so no runner.js on disk is needed.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'build', 'bin');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const version = process.argv[2] ?? '0.0.0-dev';
const only = process.argv[3]; // e.g. `darwin-arm64` for a local smoke build

const targets = [
  ['bun-darwin-arm64', 'lobstah-darwin-arm64'],
  ['bun-darwin-x64', 'lobstah-darwin-x64'],
  ['bun-linux-x64', 'lobstah-linux-x64'],
  ['bun-linux-arm64', 'lobstah-linux-arm64'],
  ['bun-windows-x64', 'lobstah-windows-x64.exe'],
];

for (const [target, name] of targets) {
  if (only && !target.includes(only)) continue;
  execFileSync(
    'bun',
    [
      'build', '--compile', `--target=${target}`,
      '--external', '@anthropic-ai/claude-agent-sdk',
      '--external', '@openai/codex-sdk',
      '--define', `process.env.LOBSTAH_BUILD_VERSION=${JSON.stringify(version)}`,
      'apps/cli/src/main.ts',
      '--outfile', path.join(out, name),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  console.log(`built ${name} @ ${version}`);
}
