import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listTraps, lobstahHome, postNotice, trapRepoLabel, type TrapRegistration } from '@lobstah/core';
import { listCodexHooks } from './codex-hook-list.js';
import { trustForCodexServer } from './codex-server.js';
import { installedCodexPlugin } from './plugin-version.js';

const FINGERPRINT_FILE = 'codex-plugin-fingerprint';

/**
 * A hash of every file in the installed lobstah Codex plugin. Since 0.166,
 * Codex ties a plugin hook's trust to the plugin's contents: when they
 * change, a running session refuses lobstah's hooks ("plugin contents
 * changed; hook approval required"), so a trap can't park or beat.
 * Undefined when the plugin isn't installed.
 */
export function codexPluginFingerprint(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): string | undefined {
  const plugin = installedCodexPlugin(opts);
  if (!plugin) return undefined;
  const hash = createHash('sha256').update(plugin.version);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hash.update(path.relative(plugin.root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
    }
  };
  walk(plugin.root);
  return hash.digest('hex');
}

/** Test seams; production uses Codex itself and the real config. */
export interface CodexHookWatchDeps {
  fingerprint?: () => string | undefined;
  refreshServerTrust?: (trap: TrapRegistration) => Promise<void>;
}

/**
 * The daemon's `codexHookWatch` hook. When the lobstah Codex plugin
 * changes, Codex stops running lobstah's hooks in sessions trusted for the
 * old one. A trap on the shared server takes its trust from Codex's
 * config.toml, which the server re-reads, so lobstah refreshes it there. A
 * trap in its own TUI was trusted by launch flags that can't change while it
 * runs: the helm hears once which traps those are and how to restore them.
 */
export function createCodexHookWatch(deps: CodexHookWatchDeps = {}): (now: number, log: (message: string) => void) => Promise<void> | undefined {
  let running = false;
  return (now, log) => {
    if (running) return undefined;
    const current = (deps.fingerprint ?? codexPluginFingerprint)();
    if (!current) return undefined;
    const file = path.join(lobstahHome(), FINGERPRINT_FILE);
    let known: string | undefined;
    try {
      known = fs.readFileSync(file, 'utf8');
    } catch {
      // First look: nothing to compare with.
    }
    if (known === current) return undefined;
    if (known === undefined) {
      fs.writeFileSync(file, current);
      return undefined;
    }
    const changedAt = now;
    const traps = listTraps().filter((trap) => trap.harness === 'codex' && Date.parse(trap.signedOnAt) < changedAt);
    running = true;
    return (async () => {
      let refreshed = true;
      for (const trap of traps.filter((t) => t.codexServer)) {
        try {
          await (deps.refreshServerTrust ?? refreshServerTrust)(trap);
          log(`lobstah's Codex plugin changed: refreshed hook trust for trap ${trap.name ?? trap.trapId} on the shared server`);
        } catch (error) {
          refreshed = false;
          log(`could not refresh hook trust for trap ${trap.name ?? trap.trapId}, will retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const stuck = traps.filter((t) => !t.codexServer);
      if (stuck.length) {
        postNotice({
          kind: 'codex-hooks-stale',
          text:
            `lobstah's Codex plugin changed, so Codex now refuses lobstah's hooks in ${stuck.map(trapRepoLabel).join(', ')}: ` +
            `they were trusted for the old plugin when they started. They can't park or report liveness until restarted. ` +
            `Restore each with \`lobstah stow --wt <id>\`, then \`lobstah man throw <name>\`: the re-throw resumes the same thread with trust for the new plugin.`,
          dedupeKey: `codex-hooks-stale-${current.slice(0, 16)}`,
        });
        log(`lobstah's Codex plugin changed: ${stuck.length} trap(s) in their own Codex TUI need a re-throw for their hooks to run`);
      }
      // A refresh that failed is tried again on the next tick.
      if (refreshed) fs.writeFileSync(file, current);
    })().finally(() => {
      running = false;
    });
  };
}

async function refreshServerTrust(trap: TrapRegistration): Promise<void> {
  trustForCodexServer(trap.worktree, trap.trapId, await listCodexHooks(trap.worktree));
}
