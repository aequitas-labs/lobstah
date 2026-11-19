import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { atomicRenameSync, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';

const RUNTIME_FIELDS = ['maxForksPerCycle'] as const;
const PR_FIELDS = [
  'autoRepair',
  'conflicts',
  'checks',
  'maxRepairsPerPr',
  'maxRepairsWithoutProgress',
  'repairSettleSecs',
  'repairCooldownSecs',
  'repairTrapWaitSecs',
] as const;

export interface WatchTypeConfiguration {
  enabled?: boolean;
  module?: string;
  apiVersion?: number;
  [key: string]: unknown;
}

/** The replacement format separates runtime settings from source-specific options. */
export interface WatchConfiguration {
  maxForksPerCycle?: number;
  attention?: { enabledKinds?: string[] };
}

export interface ConfigurationUpgrade {
  original: string;
  document: string;
  raw: Record<string, unknown>;
  changed: boolean;
}

function table(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a table`);
  return value as Record<string, unknown>;
}

/** Prepare and validate a conversion without touching the user's original file. */
export function prepareConfigurationUpgrade(original: string): ConfigurationUpgrade {
  const raw = parse(original) as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2)
    throw new Error('Unsupported configuration schemaVersion; use a matching lobstah version');
  const legacy = raw.watch !== undefined || raw.attentionKinds !== undefined || raw.readySettleSecs !== undefined;
  if (raw.schemaVersion === 2) {
    if (legacy) throw new Error('Configuration mixes schema 2 with old watch settings; run config upgrade --preview on the original file');
    validateWatchConfiguration(raw);
    return { original, document: original, raw, changed: false };
  }
  if (raw.watches !== undefined || raw.watchTypes !== undefined)
    throw new Error('Configuration mixes old and new watch settings; restore one complete configuration before upgrading');
  // Files with no watch options need no disk write until a new watch type is configured.
  if (!legacy) return { original, document: original, raw, changed: false };
  const watches: Record<string, unknown> = {};
  const pr: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.watch === undefined ? {} : table(raw.watch, '[watch]'))) {
    if ((RUNTIME_FIELDS as readonly string[]).includes(key)) watches[key] = value;
    else if ((PR_FIELDS as readonly string[]).includes(key)) pr[key] = value;
    else throw new Error(`Cannot upgrade unknown [watch].${key}; remove or correct that setting first`);
  }
  if (raw.attentionKinds !== undefined) watches.attention = { enabledKinds: raw.attentionKinds };
  if (raw.readySettleSecs !== undefined) pr.readySettleSecs = raw.readySettleSecs;
  delete raw.watch;
  delete raw.attentionKinds;
  delete raw.readySettleSecs;
  raw.schemaVersion = 2;
  if (Object.keys(watches).length) raw.watches = watches;
  if (Object.keys(pr).length) raw.watchTypes = { pr };
  validateWatchConfiguration(raw);
  return { original, raw, document: upgradeDocument(original, raw), changed: true };
}

/** Move only watch statements so comments and unrelated tables keep their spelling. */
function upgradeDocument(original: string, raw: Record<string, unknown>): string {
  const lines = original.split(/(?<=\n)/);
  const kept: string[] = [];
  let inWatch = false,
    inRoot = true;
  for (let index = 0; index < lines.length; index++) {
    let statement = lines[index]!;
    if (!statement.trim() || statement.trimStart().startsWith('#')) {
      kept.push(statement);
      continue;
    }
    // A complete TOML statement can span arrays or multiline strings. Parsing
    // each candidate avoids mistaking a value's [text] for a table header.
    for (;;) {
      try {
        parse(statement);
        break;
      } catch {
        if (index + 1 >= lines.length) throw new Error('Cannot locate a complete configuration statement');
        statement += lines[++index]!;
      }
    }
    if (/^\s*\[/.test(statement)) {
      inWatch = /^\s*\[watch\]\s*(?:#.*)?(?:\r?\n)?$/.test(statement);
      inRoot = false;
      if (!inWatch) kept.push(statement);
      else {
        const comment = /#.*$/.exec(statement.trimEnd())?.[0];
        if (comment) kept.push(comment + '\n');
      }
      continue;
    }
    if (inWatch) continue;
    const parsed = parse(statement);
    if (inRoot && ['watch', 'attentionKinds', 'readySettleSecs'].some((key) => Object.hasOwn(parsed, key))) continue;
    kept.push(statement);
  }
  const moved = {
    schemaVersion: 2,
    ...(raw.watches ? { watches: raw.watches } : {}),
    ...(raw.watchTypes ? { watchTypes: raw.watchTypes } : {}),
  };
  // Put the version at root; append source tables after all unrelated content.
  const converted = stringify(moved);
  const versionEnd = converted.indexOf('\n');
  return converted.slice(0, versionEnd + 1) + kept.join('').trimEnd() + '\n' + converted.slice(versionEnd + 1);
}

/** Only structural runtime validation lives here; each installed type owns its options. */
export function validateWatchConfiguration(raw: Record<string, unknown>): void {
  const watches = raw.watches === undefined ? {} : table(raw.watches, '[watches]');
  for (const key of Object.keys(watches)) if (!['maxForksPerCycle', 'attention'].includes(key)) throw new Error(`Unknown [watches].${key}`);
  if (watches.maxForksPerCycle !== undefined && (!Number.isSafeInteger(watches.maxForksPerCycle) || Number(watches.maxForksPerCycle) < 0))
    throw new Error('[watches].maxForksPerCycle must be a non-negative whole number');
  if (watches.attention !== undefined) {
    const attention = table(watches.attention, '[watches.attention]');
    if (
      Object.keys(attention).some((key) => key !== 'enabledKinds') ||
      !Array.isArray(attention.enabledKinds) ||
      attention.enabledKinds.some((kind) => typeof kind !== 'string')
    )
      throw new Error('[watches.attention].enabledKinds must be a list of kinds');
  }
  const types = raw.watchTypes === undefined ? {} : table(raw.watchTypes, '[watchTypes]');
  for (const [id, value] of Object.entries(types)) {
    if (!/^[a-z][a-z0-9.-]*$/.test(id)) throw new Error(`Invalid watch type ID: ${id}`);
    const options = table(value, `[watchTypes.${id}]`);
    if (options.enabled !== undefined && typeof options.enabled !== 'boolean')
      throw new Error(`[watchTypes.${id}].enabled must be true or false`);
    if (options.module !== undefined && (typeof options.module !== 'string' || !options.module))
      throw new Error(`[watchTypes.${id}].module must name a built-in or process module`);
    if (options.apiVersion !== undefined && options.apiVersion !== 1) throw new Error(`[watchTypes.${id}].apiVersion must be 1`);
  }
}

/** Publish only after the complete converted application configuration validates. */
export function applyConfigurationUpgrade(file: string, upgrade: ConfigurationUpgrade): boolean {
  if (!upgrade.changed) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withDirLock(
    `${file}.upgrade-lock`,
    () => {
      const current = fs.readFileSync(file, 'utf8');
      if (current === upgrade.document) return false;
      if (current !== upgrade.original) throw new Error('Configuration changed during upgrade; retry with the current file');
      const backup = `${file}.schema-1.bak`;
      try {
        fs.writeFileSync(backup, current, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const temporary = uniqueTempPath(file);
      try {
        fs.writeFileSync(temporary, upgrade.document, { mode: fs.statSync(file).mode & 0o777 });
        atomicRenameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return true;
    },
    { staleMs: 120_000, waitMs: 10_000, busy: () => new Error('Configuration upgrade is busy; retry') },
  );
}
