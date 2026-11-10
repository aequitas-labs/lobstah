import { decisionDir, readDecision, readDecisionAnswer, readStoredRunScript } from '@lobstah/core';
import type { DecisionMeta } from '@lobstah/core';
import {
  PasskeyError,
  RUN_RP_ID,
  RunChallenges,
  addRunPasskey,
  readRunPasskeys,
  verifyExistingPasskey,
  verifyRegistration,
  verifyRunAssertion,
  type AssertionResponse,
  type RegistrationResponse,
} from './run-passkey.js';

/**
 * The glass's run-card requests (`/requests` kinds `run-*`), behind its
 * Host, Origin and page-token check. Passkey ceremonies need the page at
 * `http://localhost:<port>`, the relying party's origin.
 */

/** The request kinds this module answers. */
export const RUN_REQUEST_KINDS = ['run-passkey-challenge', 'run-passkey-register', 'run-challenge', 'run-assert'] as const;
export type RunRequestKind = (typeof RUN_REQUEST_KINDS)[number];

export const isRunRequestKind = (kind: unknown): kind is RunRequestKind => RUN_REQUEST_KINDS.includes(kind as RunRequestKind);

/** A reply: an HTTP status and its JSON body. */
export interface RunReply {
  status: number;
  body: Record<string, unknown>;
}

/** What a run request needs from the server that received it. */
export interface RunRequestContext {
  /** `http://<Host>` of the request, which the glass already matched to its own. */
  origin: string;
  challenges: RunChallenges;
  /**
   * Chris's go-ahead to store a new passkey, asked outside the browser so a
   * local process holding the page token can't give it. Resolves to the
   * reason it was refused, or undefined when allowed.
   */
  confirmRegistration: () => Promise<string | undefined>;
  passkeysFile?: string;
}

const refuse = (status: number, reason: string): RunReply => ({ status, body: { ok: false, reason } });

/** The standing run card a key names, and its script as stored now, or the reason it can't run. */
export function runnableCard(key: unknown): { meta: DecisionMeta & { run: NonNullable<DecisionMeta['run']> } } | RunReply {
  if (typeof key !== 'string' || !/^decision:[a-f0-9]{8}$/.test(key)) return refuse(400, 'A run card key is required.');
  const meta = readDecision(key);
  if (!meta?.run) return refuse(404, `No run card ${key}.`);
  if (readDecisionAnswer(key)) return refuse(409, `Run card ${key} is already answered.`);
  const stored = readStoredRunScript(decisionDir(key)!);
  if (stored?.sha256 !== meta.run.scriptSha256) return refuse(409, "The stored script no longer matches the card's hash, so it won't run.");
  return { meta: meta as DecisionMeta & { run: NonNullable<DecisionMeta['run']> } };
}

const passkeyOrigin = (ctx: RunRequestContext): RunReply | undefined =>
  new URL(ctx.origin).hostname === RUN_RP_ID ? undefined : refuse(409, `Passkeys work from ${ctx.origin.replace('127.0.0.1', RUN_RP_ID)}: open the glass there.`);

/** Answer one run request. */
export async function handleRunRequest(kind: RunRequestKind, payload: unknown, ctx: RunRequestContext): Promise<RunReply> {
  const wrongOrigin = passkeyOrigin(ctx);
  if (wrongOrigin) return wrongOrigin;
  const p = (payload ?? {}) as Record<string, unknown>;
  try {
    switch (kind) {
      case 'run-passkey-challenge': {
        // Once a passkey exists, another needs its consent too: a second challenge, for it to sign.
        const existing = readRunPasskeys(ctx.passkeysFile);
        return {
          status: 200,
          body: {
            ok: true,
            challenge: ctx.challenges.issue({ kind: 'register' }),
            rpId: RUN_RP_ID,
            registered: existing.length,
            ...(existing.length ? { existingChallenge: ctx.challenges.issue({ kind: 'existing' }), credentialIds: existing.map((k) => k.credentialId) } : {}),
          },
        };
      }
      case 'run-passkey-register': {
        const passkey = verifyRegistration(p as unknown as RegistrationResponse, ctx.challenges, ctx.origin);
        if (readRunPasskeys(ctx.passkeysFile).length) {
          if (!p.existing) return refuse(403, 'A passkey is already registered: confirm with it to register another.');
          verifyExistingPasskey(p.existing as AssertionResponse, ctx.challenges, ctx.origin, ctx.passkeysFile);
        }
        const refused = await ctx.confirmRegistration();
        if (refused) return refuse(403, refused);
        addRunPasskey(passkey, ctx.passkeysFile);
        return { status: 201, body: { ok: true, credentialId: passkey.credentialId, createdAt: passkey.createdAt } };
      }
      case 'run-challenge': {
        const card = runnableCard(p.key);
        if ('status' in card) return card;
        if (p.sha256 !== card.meta.run.scriptSha256) return refuse(409, "The script this page shows is not the card's: reload it.");
        if (!readRunPasskeys(ctx.passkeysFile).length) return refuse(409, 'Set up a passkey in Settings to run cards.');
        return {
          status: 200,
          body: { ok: true, challenge: ctx.challenges.issue({ kind: 'run', key: card.meta.key, sha256: card.meta.run.scriptSha256 }), rpId: RUN_RP_ID, credentialIds: readRunPasskeys(ctx.passkeysFile).map((k) => k.credentialId) },
        };
      }
      case 'run-assert': {
        const verified = verifyRunAssertion(p as unknown as AssertionResponse, ctx.challenges, ctx.origin, ctx.passkeysFile);
        if (verified.key !== p.key) return refuse(403, 'The passkey signed a different card.');
        const card = runnableCard(p.key);
        if ('status' in card) return card;
        if (verified.sha256 !== card.meta.run.scriptSha256) return refuse(409, "The passkey signed a script that is not the card's.");
        return { status: 200, body: { ok: true, verified: true, key: card.meta.key } };
      }
    }
  } catch (err) {
    if (err instanceof PasskeyError) return refuse(err.status, err.message);
    throw err;
  }
}
