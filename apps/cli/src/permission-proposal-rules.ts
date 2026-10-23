import { GrantError, type PermissionRuleChange, type PermissionsConfig } from '@lobstah/core';
import { codexBaseRules } from './codex-permissions.js';
import { baseProfile } from './permissions.js';

/** One exact allow-list change that the person may include or untick on a proposal. */
export type { PermissionRuleChange } from '@lobstah/core';

export interface PermissionProposalInput {
  codexAllow: string[];
  codexRemove: string[];
  claudeAllow: string[];
  claudeRemove: string[];
  reason: string;
}

export interface ValidatedPermissionRules {
  reason: string;
  rules: PermissionRuleChange[];
  notes: string[];
}

const WRAPPERS = new Set(['env', 'sudo', 'command', 'exec', 'xargs', 'nice', 'nohup', 'timeout', 'doas']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'fish', 'dash', 'powershell', 'pwsh', 'cmd', 'ruby', 'perl']);
const BROAD_COMMANDS = new Set(['rm', 'curl', 'kill', 'killall', 'pkill']);
const executableName = (word: string): string => word.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

/** Parse argv data; removals only name existing rules and are never executed. */
function permissionWords(input: string): string[] {
  let words: unknown;
  try { words = input.trim().startsWith('[') ? JSON.parse(input) : input.trim().split(/\s+/); }
  catch { throw new GrantError('A Codex rule must be command words or a JSON argv-prefix array.'); }
  if (!Array.isArray(words) || !words.length || words.some((word) => typeof word !== 'string' || !word || /[\s\0]/.test(word)))
    throw new GrantError('Use a nonempty argv prefix with one literal word per element.');
  return words as string[];
}

/** Addition prefixes are literal words; removal-only inputs can safely name any existing argv prefix. */
export function permissionPrefix(input: string): string[] {
  const words = permissionWords(input);
  if (words.some((word) => /[;&|<>`$*?\[\]"'\\]/.test(word)))
    throw new GrantError('Use a nonempty literal argv prefix without shell syntax, quoting, wrappers or wildcards.');
  return words;
}

/** Claude proposals accept narrow Bash prefixes; a trailing wildcard is the argument scope, not executable syntax. */
export function claudePermissionPrefix(rule: string): string[] {
  const match = /^Bash\((.+)\)$/.exec(rule);
  if (!match) throw new GrantError('Claude permission proposals take Bash(command prefix *) rules.');
  return permissionPrefix(match[1]!.replace(/(?: \*|:\*)$/, ''));
}

/** Prefix overlap includes shorter proposals that would also admit a forbidden subcommand. */
function overlapsForbidden(prefix: string[], forbidden: Array<string | string[]>): boolean {
  return prefix.slice(0, Math.min(prefix.length, forbidden.length)).every((word, index) => {
    const denied = forbidden[index]!;
    return (Array.isArray(denied) ? denied : [denied]).some((value) => index === 0 ? executableName(value) === executableName(word) : value === word);
  });
}

/** A denied Bash pattern can overlap a proposed prefix even if the latter omits the denied suffix. */
function overlapsClaudeDeny(prefix: string[], rule: string): boolean {
  if (rule === 'Bash') return true;
  const body = /^Bash\((.+)\)$/.exec(rule)?.[1]?.replace(/:\*$/, ' *');
  if (!body) return false;
  const words = body.trim().split(/\s+/);
  return words.slice(0, Math.min(words.length, prefix.length)).every((word, index) => {
    const pattern = (index === 0 ? executableName(word) : word).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${pattern}$`).test(index === 0 ? executableName(prefix[index]!) : prefix[index]!);
  });
}

/** Refuse privilege controls, current profile prohibitions and prefixes broad enough to run arbitrary programs. */
export function validatePermissionPrefix(prefix: string[], current: PermissionsConfig): void {
  const executable = executableName(prefix[0]!);
  if (!executable || executable.startsWith('-')) throw new GrantError('Name a concrete executable in the permission prefix.');
  if (WRAPPERS.has(executable) || prefix[0]!.includes('=')) throw new GrantError('Environment and command wrappers cannot be proposed as allow rules.');
  const interpreter = INTERPRETERS.has(executable) || /^(?:pythonw?\d*(?:\.\d+)*|nodejs|perl\d+(?:\.\d+)*|ruby\d+(?:\.\d+)*)$/.test(executable);
  if (BROAD_COMMANDS.has(executable) || (interpreter && (prefix.length === 1 || prefix[1]?.startsWith('-'))))
    throw new GrantError('That interpreter, shell or destructive/network prefix is too broad for a permission proposal.');
  if ((['npx', 'pnpm', 'npm', 'yarn', 'bun'].includes(executable) && prefix.length === 1) ||
      (['pnpm', 'npm', 'yarn', 'bun'].includes(executable) && ['run', 'exec', 'dlx', 'x'].includes(prefix[1] ?? '') && prefix.length === 2))
    throw new GrantError('Name the concrete package command or script; a bare package runner is too broad.');
  if (['npx', 'pnpm', 'npm', 'yarn', 'bun'].includes(executable) && prefix[1]?.startsWith('-'))
    throw new GrantError('Start package-runner prefixes with the concrete command, without wrapper options.');
  if (executable === 'lobstah' && (prefix[1]?.startsWith('-') || (['permissions', 'trap'].includes(prefix[1] ?? '') && prefix[2]?.startsWith('-'))))
    throw new GrantError('That prefix could allow a forbidden permission control after reordered flags.');
  if (executable === 'npx') validatePermissionPrefix(prefix.slice(1), current);
  else if (['pnpm', 'npm', 'yarn', 'bun'].includes(executable) && ['exec', 'dlx', 'x'].includes(prefix[1] ?? ''))
    validatePermissionPrefix(prefix.slice(2), current);
  const forbidden = [...codexBaseRules().filter((rule) => rule.decision === 'forbidden').map((rule) => rule.pattern), ...current.codex.forbidden];
  if (forbidden.some((rule) => overlapsForbidden(prefix, rule)) || current.deny.some((rule) => overlapsClaudeDeny(prefix, rule)))
    throw new GrantError('That rule would allow a forbidden command in the current permission profile.');
}

/** Validate every addition before filing a card; exact duplicates and nonexistent removals produce notes, never hidden writes. */
export function validatePermissionProposal(input: PermissionProposalInput, current: PermissionsConfig): ValidatedPermissionRules {
  const reason = input.reason.trim();
  if (!reason || reason.length > 4000) throw new GrantError('permissions propose requires --reason with 1–4000 characters.');
  if (input.codexAllow.length + input.codexRemove.length + input.claudeAllow.length + input.claudeRemove.length > 100)
    throw new GrantError('A permission proposal takes at most 100 rules.');
  const rules: PermissionRuleChange[] = [];
  const notes: string[] = [];
  const seen = new Map<string, 'add' | 'remove'>();
  for (const harness of ['codex', 'claude'] as const) for (const action of ['add', 'remove'] as const) {
    const values = harness === 'codex' ? (action === 'add' ? input.codexAllow : input.codexRemove) : (action === 'add' ? input.claudeAllow : input.claudeRemove);
    for (const value of values) {
      if (value.length > 2000) throw new GrantError('Each proposed rule must be at most 2000 characters.');
      const prefix = harness === 'codex' ? (action === 'add' ? permissionPrefix(value) : permissionWords(value)) : action === 'add' ? claudePermissionPrefix(value) : [];
      if (action === 'add') validatePermissionPrefix(prefix, current);
      const rule = harness === 'codex' ? prefix : value.trim();
      const key = `${harness}:${JSON.stringify(rule)}`;
      const duplicate = seen.has(key);
      if (duplicate && seen.get(key) !== action) throw new GrantError('The same rule cannot be both added and removed.');
      seen.set(key, action);
      const configured = harness === 'codex' ? current.codex.allow.some((entry) => JSON.stringify(entry) === JSON.stringify(rule)) : current.allow.includes(rule as string);
      const inBase = action === 'add' && (harness === 'codex' ? codexBaseRules().some((entry) => entry.decision === 'allow' && JSON.stringify(entry.pattern) === JSON.stringify(rule)) : baseProfile().allow.includes(rule as string));
      const exists = configured || inBase;
      if (duplicate || (action === 'add' ? exists : !exists)) {
        notes.push(`${duplicate ? 'Duplicate' : action === 'add' ? 'Already allowed' : 'Not allowed'}; skipped ${JSON.stringify(rule)}`);
        continue;
      }
      const id = `${harness}-${action}-${rules.length}`;
      if (harness === 'codex') rules.push({ id, harness, action, rule: prefix });
      else rules.push({ id, harness, action, rule: value.trim() });
    }
  }
  if (!rules.length) throw new GrantError(`${notes.join('\n')}${notes.length ? '\n' : ''}No permission changes remain to propose.`);
  return { reason, rules, notes };
}
