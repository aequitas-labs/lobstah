/**
 * Minimal TOON (token-oriented) output: key/value blocks and compact tables
 * of the form `name[N]{a,b,c}:` followed by one comma-joined row per line.
 */
function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('\n') ? JSON.stringify(s) : s;
}

export function toonKV(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${cell(v)}`)
    .join('\n');
}

export function toonTable(name: string, rows: Array<Record<string, unknown>>, cols: string[]): string {
  const header = `${name}[${rows.length}]{${cols.join(',')}}:`;
  if (rows.length === 0) return header;
  return [header, ...rows.map((r) => `  ${cols.map((c) => cell(r[c])).join(',')}`)].join('\n');
}
