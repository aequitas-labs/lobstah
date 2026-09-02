// Build the publishable lobstah-openclaw-plugin: one bundle with @lobstah/core
// inlined and the openclaw plugin SDK external (the gateway provides it).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, 'build', 'plugin');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dist'), { recursive: true });

execFileSync(
  'npx',
  ['esbuild', 'apps/node/src/index.ts', '--bundle', '--platform=node', '--format=esm',
   '--target=node20', '--external:openclaw', '--external:openclaw/*', `--outfile=${out}/dist/index.js`],
  { cwd: root, stdio: 'inherit' },
);

const version = process.argv[2] ?? '0.1.0';
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'lobstah-openclaw-plugin',
      version,
      description: 'OpenClaw plugin for lobstah: gives fleet agents dispatch/status/send/cancel tools and operators a /lobstah command.',
      license: 'MIT',
      author: 'aequitas labs LLC',
      type: 'module',
      main: 'dist/index.js',
      files: ['dist', 'openclaw.plugin.json', 'README.md', 'LICENSE'],
      engines: { node: '>=20' },
      keywords: ['openclaw', 'openclaw-plugin', 'lobstah', 'coding-agents'],
      repository: { type: 'git', url: 'git+https://github.com/aequitas-labs/lobstah.git' },
      peerDependencies: { openclaw: '>=2026.8.2' },
      peerDependenciesMeta: { openclaw: { optional: true } },
      openclaw: { extensions: ['./dist/index.js'] },
    },
    null,
    2,
  ),
);
fs.copyFileSync(path.join(root, 'apps/node/openclaw.plugin.json'), path.join(out, 'openclaw.plugin.json'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
fs.writeFileSync(
  path.join(out, 'README.md'),
  `# lobstah-openclaw-plugin

OpenClaw plugin for [lobstah](https://www.npmjs.com/package/lobstah), the
supervisor for local coding agents. Fleet agents get four tools —
\`lobstah_dispatch\`, \`lobstah_status\`, \`lobstah_send\`, \`lobstah_cancel\` —
and operators get a \`/lobstah\` chat command. Calls translate into the same
file queue the CLI writes.

Install into a gateway host that also runs \`lobstah daemon\`:

\`\`\`bash
openclaw plugins install lobstah-openclaw-plugin
\`\`\`

Docs: https://github.com/aequitas-labs/lobstah/blob/main/docs/openclaw.md
`,
);
console.log(`built ${out} @ ${version}`);
