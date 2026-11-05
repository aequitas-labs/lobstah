import { withDirLock } from './dir-lock.js';
import { lobstahHome } from './paths.js';
import path from 'node:path';
import { askDecision, standingDecisions, withdrawDecision, type DecisionMeta } from './decisions.js';
import { desktopStartLink, type DesktopAppStart } from './desktop-start-link.js';
import { withConfiguredTrapSlot, type ConfiguredTrapSlot } from './configured-trap-slots.js';
import { readRoster } from './roster.js';
import { readTrap } from './soak.js';
import type { Config } from './config.js';

/** A desktop trap remains queued for an app session, with one deduplicated start card. */
export interface DesktopStartResult { state: 'needs-app-start'; start: DesktopAppStart; card: DecisionMeta; slot: ConfiguredTrapSlot }

/** File a concrete app-start action; clicking is not sign-on and does not start a second terminal writer. */
export function requestDesktopStart(config: Config, name: string, askedBy: string, command = 'lobstah'): DesktopStartResult {
  const profile = config.traps?.[name];
  if (!profile || profile.surface !== 'claude-desktop') throw new Error(`trap:${name} is not a configured Claude desktop profile`);
  return withDirLock(path.join(lobstahHome(), `desktop-start-${name}.lock`), () => {
    const prior = standingDecisions().find((decision) => decision.appStart?.profile === name && decision.grounds === profile.grounds);
    return withConfiguredTrapSlot(name, profile, undefined, (slot) => {
      const roster = readRoster(slot.trapId), saved = roster?.link?.startsWith('claude://') ? roster.link : undefined;
      const prompt = `Run ${command} soak --trap ${name} --grounds ${profile.grounds} --session <your own session id> --wait. Use the harness session id announced at session start. This is a repo-less configured trap.`;
      const start: DesktopAppStart = { profile: name, url: saved ?? desktopStartLink(slot.cwd, prompt) };
      const card = prior ?? askDecision({ title: `Start ${name} in Claude Code`, askedBy, grounds: profile.grounds, maxBytes: config.limits.attachmentMaxBytes,
        appStart: start, detailText: `Open the Claude desktop app's Code tab with the button below, confirm its working folder if Claude asks, then send the prefilled sign-on instruction.\n\nProfile: trap:${name}\nGrounds: ${profile.grounds}\nFolder: ${slot.cwd}\n\nSign-on instruction: ${prompt}\n\nQueued work stays with this profile until the session signs on and parks. Opening the link alone does not make it ready.`, options: [] }).meta;
      return { state: 'needs-app-start', start: card.appStart!, card, slot };
    });
  }, { staleMs: 30_000, waitMs: 1000, busy: () => new Error(`trap:${name} start card is being filed; retry`) });
}

/** A real first park withdraws its start card; merely opening the app never does. */
export function closeDesktopStartCards(trapId: string): void {
  const registration = readTrap(trapId);
  if (!registration?.firstParkedAt || !registration.configured) return;
  for (const decision of standingDecisions()) if (decision.appStart?.profile === registration.configured.profile && decision.grounds === registration.configured.grounds) withdrawDecision(decision.key);
}
