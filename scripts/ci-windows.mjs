#!/usr/bin/env node
// Whether a pull request's changes can affect lobstah on Windows, for CI's
// Windows run. Usage: node scripts/ci-windows.mjs <file listing changed paths>
// Prints `windows=true` or `windows=false` (for $GITHUB_OUTPUT), and why on
// stderr. Anything it doesn't recognise counts: an unknown path runs Windows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths that never run on a person's Windows machine:
 * - the glass pages' browser code (bundled into a page; the CLI only serves it),
 * - the wharf and telemetry Workers (they run on Cloudflare),
 * - the website and the macOS pet,
 * - docs, top-level Markdown, and GitHub files other than this workflow.
 * packages/glass-ui/src is not here: the CLI imports it (Markdown, links, the view model).
 */
const ELSEWHERE = [
  [/^packages\/glass-ui\/ui\//, 'glass page (browser)'],
  [/^apps\/cli\/glass\//, 'local glass page entry (browser)'],
  [/^services\/wharf\//, 'wharf Worker'],
  [/^services\/telemetry\//, 'telemetry Worker'],
  [/^apps\/site\//, 'website'],
  [/^apps\/pet\//, 'macOS pet'],
  [/^docs\//, 'docs'],
  [/^[^/]+\.md$/, 'top-level Markdown'],
  [/^\.github\/(?!workflows\/ci\.yml$)/, 'GitHub files'],
];

/** What a page-only test may import: the test runner, a DOM, the built pages and their fixtures, and the page code itself. */
const PAGE_IMPORTS = [
  /^vitest$/,
  /^happy-dom$/,
  /^node:fs$/,
  /^@lobstah\/core$/,
  /^\.\/glass-dom\.js$/,
  /^\.\/fixtures\//,
  /^\.\.\/src\/glass-page\.generated\.js$/,
  /^(\.\.\/)+services\/wharf\//,
  /^(\.\.\/)+packages\/glass-ui\//,
];

/**
 * A CLI test that only drives a built glass page in a DOM: it imports no CLI
 * module (only the generated page) and nothing that touches the OS
 * (processes, paths, temp dirs). A deleted test file counts as relevant.
 */
export function pageOnlyTest(file, read = (f) => fs.readFileSync(path.join(root, f), 'utf8')) {
  if (!/^apps\/cli\/test\/[^/]+\.test\.ts$/.test(file)) return false;
  let source;
  try {
    source = read(file);
  } catch {
    return false;
  }
  const imports = [...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
  return imports.some((i) => /glass-page\.generated\.js$/.test(i)) && imports.every((i) => PAGE_IMPORTS.some((p) => p.test(i)));
}

/** The decision for these changed paths, and the first path that needs Windows (if any). */
export function windowsDecision(paths, read) {
  for (const file of paths) {
    if (ELSEWHERE.some(([p]) => p.test(file))) continue;
    if (pageOnlyTest(file, read)) continue;
    return { windows: true, because: file };
  }
  return { windows: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = process.argv[2];
  const paths = fs
    .readFileSync(list, 'utf8')
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  // No changed paths (an empty diff) still runs Windows: nothing says it may skip.
  const decision = paths.length ? windowsDecision(paths) : { windows: true, because: '(no changed paths found)' };
  console.error(decision.windows ? `Windows runs: ${decision.because} can affect it.` : `Windows skips: none of the ${paths.length} changed paths run on a person's Windows machine.`);
  console.log(`windows=${decision.windows}`);
}
