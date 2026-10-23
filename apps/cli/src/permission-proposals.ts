import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import {
  answerDecision, askDecision, atomicRenameSync, configPath, DecisionError, GrantError, helmOf, liveHelms,
  loadConfig, lobstahHome, readDecision, readDecisionAnswer, uniqueTempPath, withDirLock,
  type DecisionMeta, type PermissionRuleChange, type PermissionsConfig,
} from '@lobstah/core';
import { claudeSettingsFile, planPermissionApplication, renderDiff, writePermissionApplication, type PermissionsApplication } from './permissions.js';
import { codexHome, type ExecpolicyCheck } from './codex-permissions.js';
import { editPermissionConfig } from './permission-proposal-config.js';
import { validatePermissionProposal, type PermissionProposalInput } from './permission-proposal-rules.js';

const permissionReviewHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const readText = (file: string): string | undefined => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };

/** Hash all files that an approval may change; later edits require a fresh proposal, not an unreviewed merge. */
function reviewedPermissionState(env: NodeJS.ProcessEnv): string {
  const files = [configPath(), claudeSettingsFile(env), path.join(lobstahHome(), 'claude-permissions.json'), path.join(codexHome(env), 'config.toml'), path.join(codexHome(env), 'rules/lobstah.rules')];
  return permissionReviewHash(JSON.stringify(files.map((file) => [file, readText(file)])));
}

interface ProposalPlan { config: string; application: PermissionsApplication; diff: string; targets: string[] }

/** Build the exact prospective config and existing apply diff without writing any settings. */
function planProposal(rules: PermissionRuleChange[], env: NodeJS.ProcessEnv): ProposalPlan {
  const before = readText(configPath()) ?? '';
  const config = editPermissionConfig(before, rules);
  const current = loadConfig().permissions;
  const desired: PermissionsConfig = structuredClone(current);
  for (const rule of rules) {
    if (rule.harness === 'codex') {
      desired.codex.allow = desired.codex.allow.filter((entry) => rule.action !== 'remove' || !isDeepStrictEqual(entry, rule.rule));
      if (rule.action === 'add') desired.codex.allow.push(rule.rule);
    } else {
      desired.allow = desired.allow.filter((entry) => rule.action !== 'remove' || entry !== rule.rule);
      if (rule.action === 'add') desired.allow.push(rule.rule);
    }
  }
  const parsedPermissions = (parse(config) as { permissions?: { allow?: string[]; codex?: { allow?: string[][] } } }).permissions;
  if (!isDeepStrictEqual(parsedPermissions?.allow ?? [], desired.allow) || !isDeepStrictEqual(parsedPermissions?.codex?.allow ?? [], desired.codex.allow))
    throw new GrantError('The proposed config edit did not retain the reviewed rule changes.');
  const application = planPermissionApplication(desired, env);
  if (rules.some((rule) => rule.harness === 'codex') && !application.codex) throw new GrantError('Codex is not set up here; set up its home before proposing Codex rules.');
  const diff = `${renderDiff(configPath(), rules.map((rule) => ({ op: rule.action === 'add' ? '+' : '-', at: rule.harness === 'codex' ? 'permissions.codex.allow' : 'permissions.allow', entry: JSON.stringify(rule.rule) })))}\n${application.diff}`;
  const targets = [configPath(), ...(application.codex ? [application.codex.configFile, application.codex.rulesFile] : []), application.file];
  return { config, application, diff, targets };
}

/** Only a currently claimed helm session can file proposals; traps and unidentified callers ask the helm. */
export function proposePermissions(input: PermissionProposalInput, sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env): { meta: DecisionMeta; notes: string[] } {
  const cfg = loadConfig();
  const helm = sessionId ? helmOf(sessionId) : undefined;
  if (!helm || !liveHelms(cfg.helm.ttlSecs * 1000).some((seat) => seat.sessionId === sessionId))
    throw new GrantError('Only the session holding the helm may propose permission changes; ask the helm.');
  const validated = validatePermissionProposal(input, cfg.permissions);
  const plan = planProposal(validated.rules, env);
  const { meta } = askDecision({
    title: 'Permissions proposal', askedBy: 'helm', grounds: helm.grounds,
    options: ['Approve', 'Reject', 'Edit'], maxBytes: cfg.limits.attachmentMaxBytes,
    permissionsProposal: { reason: validated.reason, rules: validated.rules, diff: plan.diff, diffHash: permissionReviewHash(plan.diff), reviewedState: reviewedPermissionState(env), targets: plan.targets },
  });
  return { meta, notes: validated.notes };
}

/** A selected subset must contain only stored rule IDs; edits cannot introduce a new permission. */
function proposalSelection(key: string, selected: unknown, env: NodeJS.ProcessEnv): { decision: DecisionMeta; rules: PermissionRuleChange[]; plan: ProposalPlan } {
  const decision = readDecision(key);
  if (!decision?.permissionsProposal) throw new DecisionError('No permissions proposal with that key.', 404);
  if (readDecisionAnswer(key)) throw new DecisionError('That proposal was already answered.', 409);
  const proposal = decision.permissionsProposal;
  if (reviewedPermissionState(env) !== proposal.reviewedState) throw new DecisionError('Permission settings changed since this proposal; ask the helm to propose it again.', 409);
  if (!Array.isArray(selected) || !selected.length || selected.some((id) => typeof id !== 'string' || !proposal.rules.some((rule) => rule.id === id)) || new Set(selected).size !== selected.length)
    throw new DecisionError('Select one or more of the proposal’s stored rules.', 400);
  const rules = proposal.rules.filter((rule) => selected.includes(rule.id));
  const validation: PermissionProposalInput = { reason: proposal.reason, codexAllow: [], codexRemove: [], claudeAllow: [], claudeRemove: [] };
  for (const rule of rules) {
    if (rule.harness === 'codex') (rule.action === 'add' ? validation.codexAllow : validation.codexRemove).push(JSON.stringify(rule.rule));
    else (rule.action === 'add' ? validation.claudeAllow : validation.claudeRemove).push(rule.rule);
  }
  validatePermissionProposal(validation, loadConfig().permissions);
  return { decision, rules, plan: planProposal(rules, env) };
}

/** Preview an unticked subset without answering the card or changing any file. */
export function previewPermissionsProposal(key: string, selected: unknown, env: NodeJS.ProcessEnv = process.env): { diff: string; diffHash: string } {
  const { plan } = proposalSelection(key, selected, env);
  return { diff: plan.diff, diffHash: permissionReviewHash(plan.diff) };
}

/** Only the dedicated glass handler calls this; CLI and generic decision answers never dispatch here. */
export function answerPermissionsProposal(key: string, option: unknown, selected: unknown, diffHash: unknown, env: NodeJS.ProcessEnv = process.env, check?: ExecpolicyCheck): { id: string } {
  fs.mkdirSync(lobstahHome(), { recursive: true });
  return withDirLock(path.join(lobstahHome(), 'permissions-proposal.lock'), () => {
    const decision = readDecision(key);
    if (!decision?.permissionsProposal) throw new DecisionError('No permissions proposal with that key.', 404);
    if (readDecisionAnswer(key)) throw new DecisionError('That proposal was already answered.', 409);
    if (option === 'Reject') {
      const answer = answerDecision({ key, option, text: 'Permission changes rejected; no settings changed.', by: 'glass', maxBytes: loadConfig().limits.attachmentMaxBytes });
      return { id: answer.request };
    }
    if (option !== 'Approve') throw new DecisionError('Use Approve or Reject; Edit changes the selected rules before approval.');
    const { rules, plan } = proposalSelection(key, selected, env);
    if (typeof diffHash !== 'string' || permissionReviewHash(plan.diff) !== diffHash) throw new DecisionError('Review the current proposal diff before approving.', 409);
    const files = [...new Set([...plan.targets, path.join(lobstahHome(), 'claude-permissions.json')])];
    const snapshots = files.map((file) => ({ file, text: readText(file), mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined }));
    const original = snapshots.find((snapshot) => snapshot.file === configPath())!;
    const backup = path.join(lobstahHome(), 'backups', `config.${new Date().toISOString().replace(/[:.]/g, '-')}.toml`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (original.text !== undefined) fs.copyFileSync(original.file, backup);
    try {
      const staged = uniqueTempPath(configPath()); fs.writeFileSync(staged, plan.config, original.mode === undefined ? {} : { mode: original.mode }); atomicRenameSync(staged, configPath());
      const applied = writePermissionApplication(plan.application, env, check);
      const text = `Applied permission changes:\n${rules.map((rule) => `${rule.action === 'add' ? '+' : '-'} ${rule.harness}: ${JSON.stringify(rule.rule)}`).join('\n')}\n${JSON.stringify({ configBackup: backup, ...applied })}`;
      const answer = answerDecision({ key, option, text, by: 'glass', maxBytes: loadConfig().limits.attachmentMaxBytes });
      return { id: answer.request };
    } catch (error) {
      for (const snapshot of snapshots) {
        if (snapshot.text === undefined) fs.rmSync(snapshot.file, { force: true });
        else { const staged = uniqueTempPath(snapshot.file); fs.writeFileSync(staged, snapshot.text, snapshot.mode === undefined ? {} : { mode: snapshot.mode }); atomicRenameSync(staged, snapshot.file); }
      }
      throw error;
    }
  }, { staleMs: 5000, waitMs: 5000, busy: () => new DecisionError('A permission proposal is already being applied; try again.', 409) });
}
