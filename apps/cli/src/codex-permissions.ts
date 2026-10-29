import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { atomicRenameSync, configPath, lobstahHome, uniqueTempPath } from '@lobstah/core';
import type { CodexRulesConfig, PermissionsConfig } from '@lobstah/core';
import type { Change } from './permissions.js';
import type { DoctorRow } from './doctor.js';
import { lobstahContext } from './permission-context.js';

/**
 * The Codex half of lobstah's permission profile. Codex has no classifier
 * context like Claude Code's `autoMode.environment`; its auto reviewer
 * (`approvals_reviewer = "auto_review"`, which `--approve-for-me` selects)
 * reads `[auto_review].extra_policy` alongside its own policy. Its command
 * rules live in `$CODEX_HOME/rules/*.rules`.
 *
 * lobstah writes two things, and nothing else in the Codex home:
 * - a block between lobstah markers inside `[auto_review].extra_policy` in
 *   `config.toml`. Text outside the markers is the user's and stays. The
 *   edit is a text edit, so comments and key order stay too, and the file
 *   is parsed before and after: every other value must be unchanged;
 * - `rules/lobstah.rules`, a file only lobstah writes (its header says so),
 *   checked with `codex execpolicy check` before it is put in place.
 * lobstah never sets `approvals_reviewer` or `approval_policy`.
 */

export const BEGIN = '<!-- lobstah:begin (written by `lobstah permissions`; edits inside are replaced) -->';
const BEGIN_PREFIX = '<!-- lobstah:begin';
export const END = '<!-- lobstah:end -->';
export const RULES_HEADER = '# Managed by lobstah.';

export type Decision = 'forbidden' | 'prompt' | 'allow';
export interface CodexRule {
  decision: Decision;
  /** argv prefix; an inner list is a union of alternatives for that word. */
  pattern: Array<string | string[]>;
  justification: string;
}

/** `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CODEX_HOME ?? path.join(home, '.codex');
}

/** Only friction removed: Codex's own reviewer keeps its safety policy. */
export function codexBaseRules(): CodexRule[] {
  return [
    { decision: 'allow', pattern: ['lobstah', 'permissions', 'propose'], justification: 'The helm may propose a change; only the person in the glass can approve applying it.' },
  ];
}

export function configRules(c: CodexRulesConfig): CodexRule[] {
  const from = `From [permissions.codex] in ${configPath()}.`;
  return (['forbidden', 'prompt', 'allow'] as const).flatMap((decision) => c[decision].map((pattern) => ({ decision, pattern, justification: from })));
}

const words = (p: Array<string | string[]>) => p.map((w) => (Array.isArray(w) ? w.join('|') : w)).join(' ');
const summary = (r: CodexRule) => `${r.decision} ${words(r.pattern)}`;
/** A command each rule must match: the first alternative of each word. */
const example = (r: CodexRule) => r.pattern.map((w) => (Array.isArray(w) ? w[0]! : w));

/** The rules file. Each rule is preceded by a summary line, which is what a later diff reads. */
export function renderRules(rules: CodexRule[]): string {
  const q = (s: string) => JSON.stringify(s);
  const body = rules.map((r) =>
    [
      `# rule: ${summary(r)}`,
      'prefix_rule(',
      `    pattern = [${r.pattern.map((w) => (Array.isArray(w) ? `[${w.map(q).join(', ')}]` : q(w))).join(', ')}],`,
      `    decision = ${q(r.decision)},`,
      `    justification = ${q(r.justification)},`,
      `    match = [${q(example(r).join(' '))}],`,
      ')',
    ].join('\n'),
  );
  return `${RULES_HEADER} \`lobstah permissions apply\` writes this file and \`lobstah permissions remove\` deletes it.\n# Add your own rules to [permissions.codex] in ${configPath()}; edits here are replaced.\n\n${body.join('\n\n')}\n`;
}

const ruleSummaries = (text: string | undefined) => (text ?? '').split('\n').filter((l) => l.startsWith('# rule: ')).map((l) => l.slice('# rule: '.length));

/** The block's entries, one per `- ` line. */
function blockEntries(policy: string | undefined): string[] {
  const m = policy === undefined ? null : new RegExp(`${escape(BEGIN_PREFIX)}[^\\n]*\\n([\\s\\S]*?)${escape(END)}`).exec(policy);
  return m ? m[1]!.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) : [];
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The policy with lobstah's block set to `entries` (or removed); the user's text around it stays. */
export function mergePolicy(policy: string | undefined, entries: string[]): string | undefined {
  const block = entries.length ? `${BEGIN}\n## lobstah\n${entries.map((e) => `- ${e}`).join('\n')}\n${END}` : '';
  const re = new RegExp(`${escape(BEGIN_PREFIX)}[^\\n]*\\n[\\s\\S]*?${escape(END)}`);
  let next: string;
  if (policy !== undefined && re.test(policy)) next = policy.replace(re, block);
  else next = policy?.trim() ? `${policy.replace(/\s+$/, '')}\n\n${block}` : block;
  next = next.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return next ? `${next}\n` : undefined;
}

/**
 * A TOML string for `value`: multi-line in the quoting the key already used
 * (`"""` or `'''`) when the text allows it, else a basic string.
 */
function tomlString(value: string, prefer: '"""' | "'''" = "'''"): string {
  const plain = !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) && value.endsWith('\n');
  // A basic string escapes its backslashes and quote runs, so the user's """ quoting survives any text.
  if (plain && prefer === '"""') return `"""\n${value.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"')}"""`;
  if (plain && !value.includes("'''")) return `'''\n${value}'''`;
  return stringify({ v: value }).replace(/^v = /, '').trim();
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const unquote = (name: string) => name.replace(/\s*\.\s*/g, '.').replace(/^"(.*)"$/, '$1');

/** Lines that open or close a multi-line string flip `inString`; headers are only read outside one. */
function scan(lines: string[]): Array<{ header?: string; inString: boolean }> {
  let open: string | undefined;
  return lines.map((line) => {
    const inString = open !== undefined;
    if (open !== undefined) {
      if (line.includes(open)) open = undefined;
      return { inString };
    }
    const header = HEADER.exec(line)?.[1];
    for (const delim of ['"""', "'''"]) {
      const count = line.split(delim).length - 1;
      if (count % 2 === 1) open = delim;
    }
    return { inString, ...(header !== undefined ? { header: unquote(header) } : {}) };
  });
}

/**
 * Set (or with undefined, remove) `extra_policy` in the `[auto_review]`
 * table by editing the text: the key's own lines change and nothing else.
 * Removing the last key of the table removes its header too.
 */
export function setExtraPolicy(text: string, value: string | undefined): string {
  const lines = text.split('\n');
  const info = scan(lines);
  const start = info.findIndex((l) => l.header === 'auto_review');
  if (start < 0) {
    if (value === undefined) return text;
    const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    return `${base}${base.trim() ? '\n' : ''}[auto_review]\nextra_policy = ${tomlString(value)}\n`;
  }
  let end = info.findIndex((l, i) => i > start && l.header !== undefined && !l.inString);
  if (end < 0) end = lines.length;
  const keyAt = lines.findIndex((l, i) => i > start && i < end && !info[i]!.inString && /^\s*extra_policy\s*=/.test(l));
  let keyEnd = keyAt;
  // A multi-line value runs on through its closing delimiter's line.
  if (keyAt >= 0) while (keyEnd + 1 < end && info[keyEnd + 1]!.inString) keyEnd++;
  const prefer = keyAt >= 0 && /=\s*"""/.test(lines[keyAt]!) ? '"""' : "'''";
  const replacement = value === undefined ? [] : `extra_policy = ${tomlString(value, prefer)}`.split('\n');
  if (keyAt < 0) {
    if (value === undefined) return text;
    lines.splice(start + 1, 0, ...replacement);
    return lines.join('\n');
  }
  lines.splice(keyAt, keyEnd - keyAt + 1, ...replacement);
  if (value === undefined) {
    const sectionEnd = end - (keyEnd - keyAt + 1);
    const rest = lines.slice(start + 1, sectionEnd);
    // An empty table goes; one still holding anything, even a comment, stays.
    if (rest.every((l) => !l.trim())) {
      const atEnd = sectionEnd >= lines.length || lines.slice(sectionEnd).every((l) => !l.trim());
      const from = atEnd && start > 0 && !lines[start - 1]!.trim() ? start - 1 : start;
      lines.splice(from, sectionEnd - from);
    }
  }
  const out = lines.join('\n');
  return text.endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out;
}

export interface CodexPlan {
  home: string;
  configFile: string;
  rulesFile: string;
  config: { before?: string; after: string };
  rules: { before?: string; after?: string };
  rulesList: CodexRule[];
  changes: Change[];
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseConfig(file: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    return parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${file} is not valid TOML (${(err as Error).message.split('\n')[0]}); fix it before lobstah merges into it`);
  }
}

/**
 * What applying (or with `remove`, removing) the Codex half would change.
 * Undefined when Codex is not set up here (no Codex home).
 */
export function planCodex(ext: PermissionsConfig, remove: boolean, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): CodexPlan | undefined {
  const dir = codexHome(env, home);
  if (!fs.existsSync(dir)) return undefined;
  const configFile = path.join(dir, 'config.toml');
  const rulesFile = path.join(dir, 'rules', 'lobstah.rules');
  const before = readText(configFile);
  const parsed = parseConfig(configFile, before);
  const review = parsed.auto_review as Record<string, unknown> | undefined;
  const current = review?.extra_policy;
  if (current !== undefined && typeof current !== 'string') throw new Error(`auto_review.extra_policy in ${configFile} is not a string`);
  if (review !== undefined && !scan((before ?? '').split('\n')).some((l) => l.header === 'auto_review')) {
    throw new Error(`auto_review in ${configFile} is set with a dotted key or an inline table; move it into an [auto_review] table and run this again`);
  }
  const entries = remove ? [] : [...new Set([...lobstahContext(), ...ext.environment])];
  const policy = mergePolicy(current as string | undefined, entries);
  const after = policy === current ? (before ?? '') : setExtraPolicy(before ?? '', policy);
  const rulesBefore = readText(rulesFile);
  if (rulesBefore !== undefined && !rulesBefore.startsWith(RULES_HEADER)) throw new Error(`${rulesFile} was not written by lobstah; rename or delete it, then run this again`);
  const rulesList = remove ? [] : [...codexBaseRules(), ...configRules(ext.codex)];
  const rulesAfter = rulesList.length ? renderRules(rulesList) : undefined;
  const diff = (at: string, was: string[], now: string[]): Change[] => [
    ...was.filter((e) => !now.includes(e)).map((entry) => ({ op: '-' as const, at, entry })),
    ...now.filter((e) => !was.includes(e)).map((entry) => ({ op: '+' as const, at, entry })),
  ];
  const changes = [
    ...diff('auto_review.extra_policy', blockEntries(current as string | undefined), blockEntries(policy)),
    ...diff('rules/lobstah.rules', ruleSummaries(rulesBefore), ruleSummaries(rulesAfter)),
  ];
  // A wording change inside the block or the file, with the same entries, is still a change.
  if (changes.length === 0 && (after !== (before ?? '') || rulesAfter !== rulesBefore)) changes.push({ op: '+', at: 'lobstah profile', entry: 'reworded' });
  return { home: dir, configFile, rulesFile, config: { ...(before !== undefined ? { before } : {}), after }, rules: { ...(rulesBefore !== undefined ? { before: rulesBefore } : {}), ...(rulesAfter !== undefined ? { after: rulesAfter } : {}) }, rulesList, changes };
}

export type ExecpolicyCheck = (rulesFile: string, command: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string; missing?: boolean };

const runCheck: ExecpolicyCheck = (rulesFile, command, env) => {
  const res = spawnSync('codex', ['execpolicy', 'check', '--rules', rulesFile, '--', ...command], { encoding: 'utf8', env, windowsHide: true, timeout: 30_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ...((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? { missing: true } : {}) };
};

/** Load the rules with Codex itself and confirm each rule matches its own example. */
export function checkRules(file: string, rules: CodexRule[], env: NodeJS.ProcessEnv, check: ExecpolicyCheck = runCheck): 'checked' | 'codex not on PATH' {
  for (const r of rules) {
    const res = check(file, example(r), env);
    if (res.missing) return 'codex not on PATH';
    let decision: unknown;
    try {
      decision = (JSON.parse(res.stdout) as { decision?: unknown }).decision;
    } catch {
      decision = undefined;
    }
    if (res.status !== 0 || decision === undefined) {
      throw new Error(`codex execpolicy check refused lobstah's rules (${summary(r)}): ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
    }
  }
  return 'checked';
}

function backup(file: string, now: Date): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const to = path.join(lobstahHome(), 'backups', `codex-${path.basename(file)}.${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(file, to);
  return to;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, text, mode !== undefined ? { mode } : {});
  atomicRenameSync(tmp, file);
}

/** Every value in `before` other than `auto_review.extra_policy` is in `after`, unchanged. */
function sameApartFromPolicy(before: Record<string, unknown>, after: Record<string, unknown>, policy: string | undefined): boolean {
  const expected = structuredClone(before);
  const review = { ...((expected.auto_review as Record<string, unknown> | undefined) ?? {}) };
  if (policy === undefined) delete review.extra_policy;
  else review.extra_policy = policy;
  if (Object.keys(review).length) expected.auto_review = review;
  else delete expected.auto_review;
  return isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), JSON.parse(JSON.stringify(after)));
}

export interface CodexWriteResult {
  codexConfig: string;
  codexRules: string;
  codexBackups?: string;
  rulesCheck?: string;
}

/**
 * Write a Codex plan: verify the new config parses to exactly the old one
 * plus lobstah's policy, check the rules with Codex, back up, then write.
 */
export function writeCodexPlan(plan: CodexPlan, env: NodeJS.ProcessEnv = process.env, check?: ExecpolicyCheck, now = new Date()): CodexWriteResult {
  const before = parseConfig(plan.configFile, plan.config.before);
  const after = parseConfig(plan.configFile, plan.config.after);
  const policy = (after.auto_review as Record<string, unknown> | undefined)?.extra_policy as string | undefined;
  if (!sameApartFromPolicy(before, after, policy)) throw new Error(`lobstah's edit to ${plan.configFile} would change more than auto_review.extra_policy; nothing was written`);
  let rulesCheck: string | undefined;
  let staged: string | undefined;
  if (plan.rules.after !== undefined) {
    fs.mkdirSync(path.dirname(plan.rulesFile), { recursive: true });
    staged = uniqueTempPath(plan.rulesFile);
    fs.writeFileSync(staged, plan.rules.after);
    try {
      rulesCheck = checkRules(staged, plan.rulesList, env, check);
    } catch (err) {
      fs.rmSync(staged, { force: true });
      throw err;
    }
  }
  const backups = [backup(plan.configFile, now), backup(plan.rulesFile, now)].filter(Boolean);
  if (plan.config.after !== (plan.config.before ?? '')) writeAtomic(plan.configFile, plan.config.after);
  if (staged) atomicRenameSync(staged, plan.rulesFile);
  else fs.rmSync(plan.rulesFile, { force: true });
  return {
    codexConfig: plan.configFile,
    codexRules: plan.rulesFile,
    ...(backups.length ? { codexBackups: backups.join(', ') } : {}),
    ...(rulesCheck ? { rulesCheck } : {}),
  };
}

/** Doctor: whether the Codex half is applied and current. */
export function codexPermissionsRow(ext: PermissionsConfig, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): DoctorRow {
  const check = 'codex permissions';
  try {
    const plan = planCodex(ext, false, env, home);
    if (!plan) return { check, status: 'skip', detail: 'Codex is not set up here' };
    if (plan.changes.length === 0) return { check, status: 'ok', detail: `lobstah's reviewer policy and rules are applied and current in ${plan.home}` };
    const applied = plan.rules.before !== undefined || blockEntries((parse(plan.config.before ?? '') as { auto_review?: { extra_policy?: string } }).auto_review?.extra_policy).length > 0;
    const add = plan.changes.filter((c) => c.op === '+').length;
    return {
      check,
      status: 'warn',
      detail: `${applied ? `out of date (${add} to add, ${plan.changes.length - add} to remove)` : "lobstah's Codex reviewer policy and rules are not applied"} — run \`lobstah permissions\` to see the diff, \`lobstah permissions apply\` to merge it`,
    };
  } catch (err) {
    return { check, status: 'warn', detail: (err as Error).message };
  }
}
