import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import type { PermissionRuleChange } from './permission-proposal-rules.js';

interface TomlStatement { start: number; end: number; text: string }

/** Statement boundaries ignore comments and quoted/triple-quoted values, including multiline arrays. */
function tomlStatements(text: string): TomlStatement[] {
  const statements: TomlStatement[] = [];
  let start = 0, depth = 0, quote = '', comment = false;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (comment) { if (char === '\n' || char === undefined) comment = false; else continue; }
    if (quote) {
      if (quote.startsWith('"') && char === '\\') { index++; continue; }
      if (text.startsWith(quote, index)) { index += quote.length - 1; quote = ''; }
      continue;
    }
    if (char === '#') { comment = true; continue; }
    if (char === '"' || char === "'") { quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char; index += quote.length - 1; continue; }
    if (char === '[' || char === '{') depth++;
    if (char === ']' || char === '}') depth--;
    if ((char === '\n' || char === undefined) && depth === 0) {
      statements.push({ start, end: index, text: text.slice(start, index) }); start = index + 1;
    }
  }
  return statements;
}

/** Parse a table/key path with TOML itself, rather than treating quoted dotted keys as syntax. */
function markerPath(source: string): string[] {
  const object = parse(source) as Record<string, unknown>;
  const path: string[] = [];
  let value: unknown = object;
  while (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return [];
    path.push(keys[0]!); value = (value as Record<string, unknown>)[keys[0]!];
  }
  return path;
}

interface ArrayEntry { start: number; end: number; comma?: number; value: unknown }

/** Locate array elements while preserving all whitespace and comments around their literal values. */
function arrayEntries(text: string, opening: number): { closing: number; entries: ArrayEntry[] } {
  const entries: ArrayEntry[] = [];
  let depth = 1, quote = '', comment = false, start = -1, end = -1;
  for (let index = opening + 1; index < text.length; index++) {
    const char = text[index]!;
    if (comment) { if (char === '\n') comment = false; else continue; }
    if (quote) {
      if (quote.startsWith('"') && char === '\\') { index++; end = index + 1; continue; }
      if (text.startsWith(quote, index)) { index += quote.length - 1; quote = ''; }
      end = index + 1; continue;
    }
    if (char === '#') { comment = true; continue; }
    if (/\s/.test(char)) continue;
    if (depth === 1 && (char === ',' || char === ']')) {
      if (start >= 0) {
        entries.push({ start, end, ...(char === ',' ? { comma: index } : {}), value: parse(`value = ${text.slice(start, end)}`).value });
        start = -1; end = -1;
      }
      if (char === ']') return { closing: index, entries };
      continue;
    }
    if (start < 0) start = index;
    if (char === '"' || char === "'") { quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char; index += quote.length - 1; }
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    end = index + 1;
  }
  throw new Error('The permissions allow array could not be edited safely.');
}

/** Edit only one explicit allow array; unsupported inline-table forms fail before a card or write. */
function editAllowArray(text: string, table: string[], changes: PermissionRuleChange[]): string {
  const statements = tomlStatements(text);
  let scope: string[] = [], headerEnd = -1;
  for (const statement of statements) {
    const trimmed = statement.text.trim();
    if (/^\[(?!\[)/.test(trimmed)) {
      scope = markerPath(`${statement.text}\n__permission_probe = true`).slice(0, -1);
      if (isDeepStrictEqual(scope, table)) headerEnd = statement.end;
      continue;
    }
    const assignment = /^(\s*(?:[\w.-]+|"(?:[^"\\]|\\.)+"|'[^']+')\s*=\s*)(\[)/.exec(statement.text);
    if (!assignment) continue;
    const keySource = assignment[1]!.replace(/=\s*$/, '= true');
    const property = markerPath(keySource);
    if (!isDeepStrictEqual([...scope, ...property], [...table, 'allow'])) continue;
    const opening = statement.start + assignment[1]!.length;
    let result = text;
    const array = arrayEntries(result, opening);
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    const remove = changes.filter((change) => change.action === 'remove');
    for (const [index, entry] of array.entries.entries()) {
      if (!remove.some((change) => isDeepStrictEqual(change.rule, entry.value))) continue;
      edits.push({ start: entry.start, end: entry.end, replacement: '' });
      const comma = entry.comma ?? array.entries[index - 1]?.comma;
      if (comma !== undefined && !edits.some((edit) => edit.start === comma)) edits.push({ start: comma, end: comma + 1, replacement: '' });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    const additions = changes.filter((change) => change.action === 'add').map((change) => JSON.stringify(change.rule));
    if (!additions.length) return result;
    const updated = arrayEntries(result, opening);
    const last = updated.entries.at(-1);
    if (last && last.comma === undefined) result = result.slice(0, last.end) + ',' + result.slice(last.end);
    const closing = updated.closing + (last && last.comma === undefined ? 1 : 0);
    const multiline = result.slice(opening, closing).includes('\n');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lineStart = result.lastIndexOf('\n', closing - 1) + 1;
    const insertAt = multiline && !result.slice(lineStart, closing).trim() ? lineStart : closing;
    const insert = multiline ? `${insertAt === closing ? eol : ''}${additions.map((value) => `  ${value},${eol}`).join('')}` : `${last ? ' ' : ''}${additions.join(', ')}`;
    return result.slice(0, insertAt) + insert + result.slice(insertAt);
  }
  const additions = changes.filter((change) => change.action === 'add').map((change) => change.rule);
  const line = `allow = ${JSON.stringify(additions)}`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (headerEnd >= 0) return text.slice(0, headerEnd) + eol + line + text.slice(headerEnd);
  return `${text}${text && !text.endsWith('\n') ? eol : ''}${eol}[${table.join('.')}]${eol}${line}${eol}`;
}

/** Surgical allow edits must parse to exactly the approved additions/removals, with every other setting unchanged. */
export function editPermissionConfig(text: string, rules: PermissionRuleChange[]): string {
  const expected = parse(text) as Record<string, unknown>;
  let result = text;
  for (const harness of ['claude', 'codex'] as const) {
    const changes = rules.filter((rule) => rule.harness === harness);
    if (!changes.length) continue;
    const permissions = (expected.permissions ??= {}) as Record<string, unknown>;
    const table = harness === 'codex' ? (permissions.codex ??= {}) as Record<string, unknown> : permissions;
    const current = (table.allow ?? []) as unknown[];
    table.allow = [...current.filter((entry) => !changes.some((change) => change.action === 'remove' && isDeepStrictEqual(change.rule, entry))), ...changes.filter((change) => change.action === 'add').map((change) => change.rule)];
    result = editAllowArray(result, harness === 'codex' ? ['permissions', 'codex'] : ['permissions'], changes);
  }
  if (!isDeepStrictEqual(parse(result), expected)) throw new Error('The permissions edit would change other config values; nothing was written.');
  return result;
}
