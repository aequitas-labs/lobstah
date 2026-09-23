// One version everywhere: the CLI's. Plugins are thin wrappers whose skills
// and commands describe CLI verbs, so each plugin manifest carries exactly
// the version of the CLI it was written against.
//
//   node scripts/sync-versions.mjs            stamp the CLI's version into every manifest
//   node scripts/sync-versions.mjs 0.6.0      bump the CLI to 0.6.0, then stamp it everywhere
//   node scripts/sync-versions.mjs --check    exit 1 listing every manifest that disagrees
//
// The source of truth is apps/cli/package.json — the `lobstah` package that
// `lobstah version` reports and the release publishes (the root
// package.json is the private workspace and carries no version).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'apps/cli/package.json';

/**
 * Every manifest that must carry the CLI's version. The OpenClaw plugin's
 * version of record is its npm package (apps/node/package.json, which
 * scripts/build-plugin.mjs publishes); openclaw.plugin.json has no version
 * field, so it has nothing to stamp. The marketplace entry carries no version
 * today; if one is added, it is kept in step too.
 */
export const TARGETS = [
  'plugins/claude-code/.claude-plugin/plugin.json',
  'plugins/codex/.codex-plugin/plugin.json',
  'apps/node/package.json',
  'apps/node/openclaw.plugin.json',
  '.claude-plugin/marketplace.json',
];

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

export function cliVersion(root) {
  return JSON.parse(read(root, SOURCE)).version;
}

/** The version fields a manifest carries: its own, and any marketplace plugin entries'. */
function versionsIn(json) {
  const out = [];
  if (typeof json.version === 'string') out.push(['version', json.version]);
  if (json.metadata && typeof json.metadata.version === 'string') out.push(['metadata.version', json.metadata.version]);
  for (const [i, p] of (json.plugins ?? []).entries()) {
    if (p && typeof p.version === 'string') out.push([`plugins[${i}].version`, p.version]);
  }
  return out;
}

/** Every manifest field that disagrees with the CLI: [{ file, field, found, want }]. */
export function checkVersions(root) {
  const want = cliVersion(root);
  const bad = [];
  for (const rel of TARGETS) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    for (const [field, found] of versionsIn(JSON.parse(read(root, rel)))) {
      if (found !== want) bad.push({ file: rel, field, found, want });
    }
  }
  return bad;
}

/**
 * Rewrite the top-level "version" in place — the first occurrence, verified
 * by re-parsing — so hand-formatted manifests keep their formatting. Nested
 * marketplace versions (if any) go through a JSON rewrite.
 */
function stamp(file, version) {
  const before = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(before);
  let text = before;
  if (typeof json.version === 'string') {
    text = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
    if (JSON.parse(text).version !== version) throw new Error(`${file}: the first "version" is not the top-level one — edit it by hand`);
  }
  const nested = JSON.parse(text);
  let rewrite = false;
  if (nested.metadata && typeof nested.metadata.version === 'string' && nested.metadata.version !== version) {
    nested.metadata.version = version;
    rewrite = true;
  }
  for (const p of nested.plugins ?? []) {
    if (p && typeof p.version === 'string' && p.version !== version) {
      p.version = version;
      rewrite = true;
    }
  }
  if (rewrite) text = `${JSON.stringify(nested, null, 2)}\n`;
  if (text !== before) fs.writeFileSync(file, text);
  return text !== before;
}

/** Stamp `version` (default: the CLI's own) into the CLI and every manifest. Returns the files changed. */
export function syncVersions(root, version) {
  const v = version ?? cliVersion(root);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`not a semver version: ${v}`);
  const changed = [];
  for (const rel of [SOURCE, ...TARGETS]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file) && stamp(file, v)) changed.push(rel);
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const arg = process.argv[2];
  if (arg === '--check') {
    const bad = checkVersions(root);
    for (const b of bad) console.error(`${b.file} ${b.field} is ${b.found}; the CLI is ${b.want} — run node scripts/sync-versions.mjs`);
    process.exit(bad.length > 0 ? 1 : 0);
  }
  const changed = syncVersions(root, arg);
  console.log(`version ${cliVersion(root)}: ${changed.length > 0 ? changed.join(', ') : 'everything already in step'}`);
}
