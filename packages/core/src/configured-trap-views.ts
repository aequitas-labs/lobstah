import { listNotices } from './notices.js';
import { standingDecisions } from './decisions.js';
import { pendingIds, queuedDescriptor } from './queue.js';
import type { Config } from './config.js';
import { configuredTrapSlots } from './configured-trap-slots.js';
import { listTraps } from './soak.js';
import { readRoster } from './roster.js';
import type { ConfiguredTrapProfile } from './configured-trap-model.js';

/** A configured worker's visible capacity and retained instances, independent of repositories. */
export interface ConfiguredTrapView {
  profile: string;
  grounds: string;
  surface: ConfiguredTrapProfile['surface'];
  harness: string;
  capacity: string;
  state: 'configured' | 'listening' | 'busy' | 'needs-app-start' | 'stowed' | 'ghosted' | 'missing-config' | 'needs-setup';
  cwd?: string;
  start?: import('./desktop-start-link.js').DesktopAppStart;
  pending?: string[];
  instances: Array<{ trapId: string; sessionId?: string; cwd: string; state: string; claimed?: string }>;
}

/** Join profile configuration to durable slots; missing configuration never retargets an instance. */
export function configuredTrapViews(config: Pick<Config, 'traps'>): ConfiguredTrapView[] {
  const slots = configuredTrapSlots(), live = listTraps();
  const defective = listNotices(Number.MAX_SAFE_INTEGER).filter((notice) => notice.kind === 'trap-defective');
  return [...new Set([...Object.keys(config.traps ?? {}), ...slots.map((slot) => slot.profile)])].sort().map((name) => {
    const profile = config.traps?.[name], owned = slots.filter((slot) => slot.profile === name);
    const instances = owned.map((slot) => {
      const registration = live.find((trap) => trap.trapId === slot.trapId);
      return { trapId: slot.trapId, sessionId: slot.sessionId, cwd: slot.cwd, state: registration ? !registration.firstParkedAt && defective.some((notice) => notice.refId === registration.trapId && notice.at >= registration.signedOnAt) ? 'needs-setup' : registration.claimed ? 'busy' : registration.firstParkedAt ? 'listening' : 'signed on' : readRoster(slot.trapId)?.state ?? 'configured', ...(registration?.claimed ? { claimed: registration.claimed } : {}) };
    });
    const surface = profile?.surface ?? owned[0]!.surface;
    const start = standingDecisions().find((card) => card.appStart?.profile === name)?.appStart;
    const pending = (['work', 'chore'] as const).flatMap((lane) => pendingIds(lane).filter((id) => queuedDescriptor(id, lane)?.target?.profile === name));
    return { profile: name, grounds: profile?.grounds ?? owned[0]!.grounds, surface, harness: profile?.harness ?? readRoster(owned[0]!.trapId)?.harness ?? 'unknown',
      ...(start ? { start } : {}), ...(pending.length ? { pending } : {}),
      capacity: `${owned.length}/${profile?.maxInstances ?? '?'}`, cwd: profile?.cwd,
      state: !profile ? 'missing-config' : instances.some((instance) => instance.state === 'needs-setup') ? 'needs-setup' : instances.some((instance) => instance.state === 'busy') ? 'busy' : instances.some((instance) => instance.state === 'listening' || instance.state === 'signed on') ? 'listening' : surface === 'claude-desktop' ? 'needs-app-start' : instances.some((instance) => instance.state === 'ghosted') ? 'ghosted' : instances.length ? 'stowed' : 'configured', instances };
  });
}
