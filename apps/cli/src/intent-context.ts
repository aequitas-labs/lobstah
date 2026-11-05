import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, grantsDir, listGrants, rosterByAddress, uniqueTempPath } from '@lobstah/core';
import type { Grant } from '@lobstah/core';
import { writeCodexIntentBlock } from './codex-permissions.js';
import { claudeSettingsFile, readSettings } from './permissions.js';

/**
 * What the harnesses' own reviewers are told about intent grants. A hook can't
 * reach either reviewer: tested on real harnesses, Claude Code's classifier and
 * Codex's reviewer read neither a hook's `additionalContext`. They read user
 * configuration: `autoMode.environment` in Claude Code's user settings, and
 * `[auto_review].extra_policy` in Codex's config. So a grant in force is written
 * there, and removed when it's revoked or lapses.
 *
 * A running Claude Code session sees the change at its next review. A running
 * Codex session doesn't: Codex reads its config when a session starts.
 *
 * This only adds context for a reviewer to weigh. It adds no rule, and the
 * reviewers keep their own policies.
 */

/** How an entry of lobstah's starts in Claude Code's environment list, so only these are ever replaced. */
const CLAUDE_ENTRY_LEAD = '**lobstah intent grant ';
/** Keeps Claude Code's built-in environment entries alongside this one. */
const DEFAULTS = '$defaults';

/** Where this grant applies, in words a reviewer can check a call against. */
function scopeText(grant: Pick<Grant, 'trap' | 'repo'>): string {
  if (grant.trap === undefined) return `the lobstah traps of repo ${grant.repo}`;
  const worktree = rosterByAddress(grant.trap)?.worktree;
  return `lobstah trap ${grant.trap}${worktree ? `, working in ${worktree}` : ''}`;
}

/** One grant as its reviewer reads it. */
export function intentContextEntry(grant: Grant): string {
  const until = grant.expiresAt ? ` until ${grant.expiresAt}` : ' until revoked';
  return (
    `${CLAUDE_ENTRY_LEAD}${grant.id}**: The user approved this kind of action for ${scopeText(grant)}${until}: "${grant.intent!.text}". ` +
    'Weigh it as the user\'s authorization for actions from that trap that fit this description. It says nothing about other traps, other directories, or other kinds of action.'
  );
}

/** The grants each harness's reviewer should be told about now. */
function intentEntries(harness: 'claude' | 'codex', grants: readonly Grant[]): string[] {
  return grants.filter((grant) => grant.mode === 'intent' && grant.intent && (grant.harness === 'any' || grant.harness === harness)).map(intentContextEntry);
}

/** Replace lobstah's intent entries in Claude Code's user settings, leaving everything else in the file alone. */
function writeClaudeEntries(entries: string[], env: NodeJS.ProcessEnv): void {
  const file = claudeSettingsFile(env);
  if (!fs.existsSync(path.dirname(file))) return;
  const settings = readSettings(file);
  const autoMode = settings.autoMode;
  if (autoMode !== undefined && (typeof autoMode !== 'object' || autoMode === null || Array.isArray(autoMode))) throw new Error(`autoMode in ${file} is not an object`);
  const holder = (autoMode ?? {}) as Record<string, unknown>;
  const current = holder.environment;
  if (current !== undefined && (!Array.isArray(current) || current.some((entry) => typeof entry !== 'string'))) throw new Error(`autoMode.environment in ${file} is not a list of strings`);
  const before = (current ?? []) as string[];
  const kept = before.filter((entry) => !entry.startsWith(CLAUDE_ENTRY_LEAD));
  // A new list keeps Claude Code's built-in context: without `$defaults`, it would replace it.
  const next = [...(current === undefined && entries.length ? [DEFAULTS] : kept), ...entries];
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  // Only `$defaults` left, and no list before lobstah's: leave the file as it was.
  if (next.length === 0 || (next.length === 1 && next[0] === DEFAULTS && entries.length === 0 && kept.length === 1)) {
    const { environment: _gone, ...rest } = holder;
    if (Object.keys(rest).length > 0) settings.autoMode = rest;
    else delete settings.autoMode;
  } else {
    settings.autoMode = { ...holder, environment: next };
  }
  const temp = uniqueTempPath(file);
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, fs.existsSync(file) ? { mode: fs.statSync(file).mode & 0o777 } : {});
  atomicRenameSync(temp, file);
}

const syncedFile = (): string => path.join(grantsDir(), 'intent-context-synced');

/**
 * Bring both reviewers' configuration in line with the intent grants in force.
 * Cheap when nothing changed, because it runs on every trap tool call: that's
 * how a lapsed grant leaves. Returns the problems it met rather than throwing:
 * the grants themselves work whatever happens here, and a hook must never fail.
 */
export function syncIntentContext(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const { grants, intact } = listGrants();
    // A damaged ledger honours nothing, so no reviewer should be told otherwise.
    const inForce = intact ? grants : [];
    const claude = intentEntries('claude', inForce);
    const codex = intentEntries('codex', inForce);
    const wanted = JSON.stringify({ claude, codex });
    let synced: string | undefined;
    try {
      synced = fs.readFileSync(syncedFile(), 'utf8');
    } catch {
      // never synced
    }
    if (synced === wanted) return [];
    const problems: string[] = [];
    for (const write of [() => writeClaudeEntries(claude, env), () => writeCodexIntentBlock(codex, env)]) {
      try {
        write();
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (problems.length === 0) {
      fs.mkdirSync(grantsDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(syncedFile(), wanted, { mode: 0o600 });
    }
    return problems;
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}
