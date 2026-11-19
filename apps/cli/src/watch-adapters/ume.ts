import { laneOf, readSessionClaim, readWatch } from '@lobstah/core';
import type { TurnWaitRegistration, Watch } from '@lobstah/core';
import type { WatchRegistrationPolicy } from '@lobstah/watch-types';
import { clearFinishedUmeWatches, prepareUmeWatch, syncUmeWatches, umeArtifact, umeTurnArtifact } from '../ume-watch.js';
import { legacyRegistration, registerLegacyWatch } from './legacy.js';

/** Review parks, report links and explicit keys use the same source registration. */
export function umeRegistration(): WatchRegistrationPolicy {
  return {
    prepare(request) {
      const forId = request.owner.kind === 'dispatch' ? request.owner.chainId : undefined;
      const options = request.options as { cursor?: string };
      let artifact: string | undefined,
        cwd = request.cwd;
      if (request.event === 'explicit' && typeof request.fields.key === 'string') artifact = request.fields.key.replace(/^ume:/, '');
      if (request.event === 'turn-wait' && forId) artifact = umeTurnArtifact(request.fields as unknown as TurnWaitRegistration);
      if (request.event === 'report' && forId && request.fields.verb === 'paused') {
        artifact = umeArtifact(`${request.fields.link ?? ''} ${request.fields.note ?? ''}`);
        const lane = laneOf(forId),
          claim = lane ? readSessionClaim(forId, lane) : undefined;
        if (!artifact || !claim?.worktree || readWatch(`ume:${artifact}`)) return undefined;
        cwd = claim.worktree;
      }
      if (!artifact) return undefined;
      const existing = readWatch(`ume:${artifact}`);
      if (existing && request.event !== 'explicit') return legacyRegistration(existing);
      const plan = prepareUmeWatch(artifact, { forId, cwd, cursor: request.cursor ?? options.cursor });
      return legacyRegistration(
        {
          ...existing,
          ...plan.options,
          key: plan.key,
          check: plan.check,
          owner: existing?.owner ?? 'man',
          cursor: existing?.cursor ?? plan.options?.cursor ?? '0',
          createdAt: existing?.createdAt ?? '1970-01-01T00:00:00.000Z',
          seen: existing?.seen ?? 0,
          seenAt: existing?.seenAt ?? 0,
        } as Watch,
        request.options,
      );
    },
    registered: registerLegacyWatch,
    sync(_now, phase) {
      if (phase === 'before-observe') syncUmeWatches();
      if (phase === 'report') clearFinishedUmeWatches();
    },
  };
}
