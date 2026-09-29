/** Links a live harness session can report for opening that exact session. */
export function validSessionLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return (
    /^claude:\/\/claude\.ai\/[A-Za-z0-9_/-]+$/.test(value) ||
    /^vscode:\/\/anthropic\.claude-code\/open\?session=[A-Za-z0-9_-]+$/.test(value) ||
    /^codex:\/\/threads\/[A-Za-z0-9-]+$/.test(value)
  );
}
