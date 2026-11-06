// Runs wrangler for the deployed wharf with this machine's own ids, which stay
// out of git. wrangler.jsonc keeps a placeholder database_id; the real one is
// in the git-ignored wrangler.local.jsonc (copy wrangler.local.example.jsonc).
// This merges the two into a git-ignored wrangler.deploy.jsonc beside them,
// runs wrangler with it, and removes it again.
//
//   pnpm --filter @lobstah/wharf run deploy                  build, check, deploy
//   pnpm --filter @lobstah/wharf run wrangler -- <command>   any wrangler command (d1 migrations apply …)
//
// It fails loudly, before wrangler runs, when the local file is missing or
// still holds a placeholder, and before a deploy when the live Worker has no
// GITHUB_CLIENT_ID (a variable set once on the Worker, kept by keep_vars).
// It prints no id.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = path.join(here, 'wrangler.jsonc');
export const LOCAL = path.join(here, 'wrangler.local.jsonc');
export const MERGED = path.join(here, 'wrangler.deploy.jsonc');
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** JSON with // and /* comments and trailing commas, as wrangler reads it. Comment markers inside strings are text. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) throw new Error('unterminated comment');
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Why this machine's local file can't be used, or undefined when it can. Never names the id itself. */
export function localProblem(local) {
  if (!local || typeof local !== 'object') return 'it is not a JSON object';
  const id = local.database_id;
  if (typeof id !== 'string' || !id) return 'it has no "database_id"';
  if (id === ZERO_ID) return '"database_id" is still the placeholder';
  if (!UUID.test(id)) return '"database_id" is not a D1 database id (a lowercase UUID)';
  return undefined;
}

/** The committed config with this machine's database id in the deployed binding (env.local keeps its placeholder). */
export function mergeLocal(config, local) {
  const databases = config.d1_databases ?? [];
  if (databases.length !== 1) throw new Error(`wrangler.jsonc has ${databases.length} D1 bindings; expected one`);
  return { ...config, d1_databases: [{ ...databases[0], database_id: local.database_id }] };
}

function fail(message) {
  console.error(`wharf: ${message}`);
  process.exit(1);
}

/** Wrangler with the merged config; its exit code. */
function wrangler(args) {
  const run = spawnSync('npx', ['--no-install', 'wrangler', ...args, '--config', MERGED], {
    cwd: here,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return run.status ?? 1;
}

/** Whether the live Worker's newest version has GITHUB_CLIENT_ID, as a variable or a secret. Reads only binding names. */
export function liveHasClientId() {
  const read = (args) =>
    spawnSync('npx', ['--no-install', 'wrangler', ...args, '--config', MERGED, '--json'], { cwd: here, encoding: 'utf8', shell: process.platform === 'win32' });
  const list = read(['versions', 'list']);
  if (list.status !== 0) return undefined;
  const versions = JSON.parse(list.stdout);
  const newest = versions.at(-1)?.id;
  if (!newest) return false;
  const view = read(['versions', 'view', newest]);
  if (view.status !== 0) return undefined;
  return (JSON.parse(view.stdout).resources?.bindings ?? []).some((b) => b.name === 'GITHUB_CLIENT_ID');
}

function main(args) {
  if (!args.length) fail('name a wrangler command: run wrangler -- <command>, or run deploy');
  if (!fs.existsSync(LOCAL))
    fail(`${path.relative(process.cwd(), LOCAL)} is missing. Copy wrangler.local.example.jsonc to it and set "database_id" (npx wrangler d1 list).`);
  let local;
  try {
    local = parseJsonc(fs.readFileSync(LOCAL, 'utf8'));
  } catch (e) {
    fail(`wrangler.local.jsonc is not valid JSON: ${e.message}`);
  }
  const problem = localProblem(local);
  if (problem) fail(`wrangler.local.jsonc can't be used: ${problem}.`);
  fs.writeFileSync(MERGED, JSON.stringify(mergeLocal(parseJsonc(fs.readFileSync(CONFIG, 'utf8')), local), null, 2) + '\n');
  try {
    const deploying = args[0] === 'deploy' && !args.includes('--dry-run');
    if (deploying) {
      const has = liveHasClientId();
      if (has === undefined) fail("couldn't read the live Worker's bindings; check `npx wrangler whoami`.");
      if (!has)
        fail('the live Worker has no GITHUB_CLIENT_ID. Set it once: `npx wrangler secret put GITHUB_CLIENT_ID`, or as a variable in the dashboard.');
    }
    process.exitCode = wrangler(args);
  } finally {
    fs.rmSync(MERGED, { force: true });
  }
}

// Real paths on both sides: a script run through a symlink (macOS's /var → /private/var) is still this one.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
