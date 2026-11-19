import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { builtinWatchRegistry } from '../src/watch-source-registry.js';
import { DeploymentWatchType } from '@lobstah/watch-types/deployment';
import { removeTempDir } from '../../../test/temp-dir.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// Legacy source modules remain adapter-owned while callers migrate to the registry.
function adapterOwned(file: string): boolean {
  return (
    /\/(?:watch-adapters|watch-sources|watch-presenters|adapters)\//.test(file) ||
    /^packages\/watch-types\/src\/(?:pr|ume|review|stack|local|deployment)\//.test(file) ||
    /\/(?:pr(?:s)?(?:-|\.)|ume-|stack-|review(?:s)?(?:-|\.)|glass-prs\.|trap-pr-wait\.|beat-pr\.|repair-holds\.|watch-merge-policy\.|watch-review-requests\.|bound-pr\.|pr-evidence\.|local-watch-source\.)/.test(
      file,
    )
  );
}
function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'test', 'tests', 'build', '.git'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [file] : [];
  });
}

it('keeps builtin key prefixes inside adapter-owned files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-adapter-boundaries-'));
  const previous = process.env.LOBSTAH_HOME;
  process.env.LOBSTAH_HOME = home;
  try {
    const prefixes = [...builtinWatchRegistry().list(), new DeploymentWatchType()]
      .map((source) => source.descriptor.keyPrefix)
      .filter((prefix): prefix is string => !!prefix);
    expect(prefixes.length).toBeGreaterThan(5);
    const patterns = prefixes.map((prefix) => ({
      prefix,
      pattern: new RegExp(`(?:^|[^A-Za-z0-9_-])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    }));
    const violations: string[] = [];
    for (const file of ['apps', 'packages', 'services'].flatMap((directory) => sources(path.join(root, directory)))) {
      const relative = path.relative(root, file).replaceAll(path.sep, '/');
      if (adapterOwned(relative)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const report = (node: ts.Node, detail: string) =>
        violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${detail}`);
      function visit(node: ts.Node): void {
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isRegularExpressionLiteral(node)
        ) {
          for (const { prefix, pattern } of patterns) if (pattern.test(node.text)) report(node, prefix);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LOBSTAH_HOME;
    else process.env.LOBSTAH_HOME = previous;
    removeTempDir(home);
  }
});
