import fs from 'node:fs';
import path from 'node:path';
import { configuredTrapSlots } from './configured-trap-slots.js';
import { lobstahHome } from './paths.js';
import { postNotice } from './notices.js';
import type { Config } from './config.js';

/** Missing profiles retain their identities and catches; one notice marks each removal epoch. */
export function reconcileConfiguredProfiles(config: Pick<Config, 'traps'>): void {
  for (const slot of configuredTrapSlots()) {
    const marker = path.join(lobstahHome(), 'configured-traps', `${slot.trapId}.missing`);
    if (config.traps?.[slot.profile]?.grounds === slot.grounds) { fs.rmSync(marker, { force: true }); continue; }
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, String(Date.now()));
    const epoch = fs.readFileSync(marker, 'utf8');
    postNotice({ kind: 'trap-profile-missing', grounds: slot.grounds, refId: slot.trapId,
      text: `Configured trap:${slot.profile} no longer has its profile in grounds ${slot.grounds}. Existing catches and its folder are kept; new claims wait for the profile to return.`,
      dedupeKey: `profile-missing-${slot.trapId}-${epoch}` });
  }
}
