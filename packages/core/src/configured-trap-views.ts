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
  state: 'configured' | 'listening' | 'busy' | 'needs-app-start' | 'stowed' | 'ghosted' | 'missing-config';
  cwd?: string;
  instances: Array<{ trapId: string; sessionId?: string; cwd: string; state: string; claimed?: string }>;
}

/** Join profile configuration to durable slots; missing configuration never retargets an instance. */
export function configuredTrapViews(config: Pick<Config, 'traps'>): ConfiguredTrapView[] {
  const slots = configuredTrapSlots(), live = listTraps();
  return [...new Set([...Object.keys(config.traps ?? {}), ...slots.map((slot) => slot.profile)])].sort().map((name) => {
    const profile = config.traps?.[name], owned = slots.filter((slot) => slot.profile === name);
    const instances = owned.map((slot) => {
      const registration = live.find((trap) => trap.trapId === slot.trapId);
      return { trapId: slot.trapId, sessionId: slot.sessionId, cwd: slot.cwd, state: registration ? registration.claimed ? 'busy' : registration.firstParkedAt ? 'listening' : 'signed on' : readRoster(slot.trapId)?.state ?? 'configured', ...(registration?.claimed ? { claimed: registration.claimed } : {}) };
    });
    const surface = profile?.surface ?? owned[0]!.surface;
    return { profile: name, grounds: profile?.grounds ?? owned[0]!.grounds, surface, harness: profile?.harness ?? readRoster(owned[0]!.trapId)?.harness ?? 'unknown',
      capacity: `${owned.length}/${profile?.maxInstances ?? '?'}`, cwd: profile?.cwd,
      state: !profile ? 'missing-config' : instances.some((instance) => instance.state === 'busy') ? 'busy' : instances.some((instance) => instance.state === 'listening' || instance.state === 'signed on') ? 'listening' : surface === 'claude-desktop' ? 'needs-app-start' : instances.some((instance) => instance.state === 'ghosted') ? 'ghosted' : instances.length ? 'stowed' : 'configured', instances };
  });
}
