import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

it('keeps the generic SDK dependency graph independent of builtin adapters and host packages', () => {
  const visited = new Set<string>(),
    violations: string[] = [];
  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const relative = path.relative(sourceRoot, file).replaceAll(path.sep, '/');
    if (relative.startsWith('../') || /^(pr|ume|review|stack|local|deployment|adapters)\//.test(relative)) {
      violations.push(relative);
      return;
    }
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      const reference = node.moduleSpecifier;
      if (!reference || !ts.isStringLiteral(reference)) continue;
      if (reference.text.startsWith('@lobstah/')) violations.push(`${relative}: ${reference.text}`);
      if (reference.text.startsWith('.')) visit(path.resolve(path.dirname(file), reference.text.replace(/\.js$/, '.ts')));
    }
  }
  for (const entry of ['index.ts', 'presentation.ts', 'plugin-worker.ts']) visit(path.join(sourceRoot, entry));
  expect(violations).toEqual([]);
  expect(visited.size).toBeGreaterThan(5);
});

it('exposes builtin adapters through optional entry points while the kernel exports only generic contracts', async () => {
  const kernel = (await import('../dist/index.js')) as Record<string, unknown>;
  expect(typeof kernel.BaseWatchType).toBe('function');
  expect(kernel.PrWatchType).toBeUndefined();
  expect(kernel.UmeWatchType).toBeUndefined();
  expect(typeof (await import('@lobstah/watch-types/pr')).PrWatchType).toBe('function');
  expect(typeof (await import('@lobstah/watch-types/ume')).UmeWatchType).toBe('function');
});
