import type { GlassRunCard, GlassSnapshot } from '@lobstah/core';
import { scriptWarnings, sha256Hex } from '@lobstah/core';
import { ago, emptyFleet } from './glass-snapshots.js';

/** The run card fixtures' key, and the dispatch it is about. */
export const RUN_KEY = 'decision:0e0e0e0e';
export const RUN_DISPATCH = 'aaaaaaaa-0000-4000-8000-0000000000aa';

/** A script that wipes potluck test mail with a secret read from stdin. */
export const MAIL_WIPE = `#!/bin/bash
IFS= read -r CRON_SECRET
curl -fsS -X POST https://potluck.example/api/cron/mail-wipe \\
  -H @<(printf 'Authorization: Bearer %s\\n' "$CRON_SECRET")
`;

/** The glass's view of a run card for `script`. */
export function glassRun(script = MAIL_WIPE, over: Partial<GlassRunCard> = {}): GlassRunCard {
  return {
    scriptSha256: sha256Hex(script),
    scriptBytes: Buffer.byteLength(script),
    inputs: [{ name: 'CRON_SECRET', secret: true }],
    cwd: '/Users/me/base/homebase',
    timeoutSecs: 300,
    output: 'scrubbed',
    interpreter: '/bin/bash',
    script,
    warnings: scriptWarnings(script),
    ...over,
  };
}

/** A fleet whose one standing decision is a run card, on this Mac with a page token. */
export function runCardFleet(run: GlassRunCard = glassRun()): GlassSnapshot {
  const d = emptyFleet();
  d.focusToken = 'tok';
  d.viewer = { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' };
  d.attention = [
    {
      kind: 'decision',
      key: RUN_KEY,
      stateHash: 'run1',
      id: RUN_DISPATCH,
      lane: 'work',
      verb: 'decision',
      ageSecs: 60,
      at: ago(60_000),
      standingSince: ago(60_000),
      note: 'Wipe potluck test mail',
      repo: 'web',
    },
  ];
  d.decisions = [
    {
      key: RUN_KEY,
      title: 'Wipe potluck test mail',
      detail: 'Runs the mail wipe with the cron secret.\n',
      options: ['Decline'],
      run,
      attachments: [],
      dispatch: RUN_DISPATCH,
      lane: 'work',
      repo: 'web',
      askedBy: 'helm',
      askedAt: ago(60_000),
      stateHash: 'run1',
    },
  ];
  d.answerLimits = { maxBytes: 1024, maxFiles: 8, textMax: 20_000, extensions: ['.png', '.txt'] };
  return d;
}
