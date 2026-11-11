import { decisionDir, readDecision, readDecisionAnswer, readStoredRunScript, withdrawDecision } from '@lobstah/core';
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
import { RunRegistry, runStdin } from './run-exec.js';

/**
 * The glass's run-card requests (`/requests` kinds `run-*`), behind its
 * Host, Origin and page-token check. Passkey ceremonies need the page at
 * `http://localhost:<port>`, the relying party's origin.
 */

/** The request kinds this module answers. */
export const RUN_REQUEST_KINDS = [
  'run-passkey-challenge',
  'run-passkey-register',
  'run-challenge',
  'run',
  'run-output',
  'run-line',
  'run-stop',
  'run-dismiss',
] as const;
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
  /** The runs this server started. */
  runs: RunRegistry;
  /** Per-file answer limit (limits.attachmentMaxBytes), for the answer a run writes. */
  maxBytes: number;
}

const refuse = (status: number, reason: string): RunReply => ({ status, body: { ok: false, reason } });

/** The standing run card a key names, and its script as stored now, or the reason it can't run. */
export function runnableCard(key: unknown): { meta: DecisionMeta & { run: NonNullable<DecisionMeta['run']> } } | RunReply {
  if (typeof key !== 'string' || !/^decision:[a-f0-9]{8}$/.test(key)) return refuse(400, 'A run card key is required.');
  const meta = readDecision(key);
  if (!meta?.run) return refuse(404, `No run card ${key}.`);
  if (readDecisionAnswer(key)) return refuse(409, `Run card ${key} is already answered.`);
  const stored = readStoredRunScript(decisionDir(key)!);
  if (stored?.sha256 !== meta.run.scriptSha256) return refuse(409, "This script changed after it was proposed, so it can't run.");
  return { meta: meta as DecisionMeta & { run: NonNullable<DecisionMeta['run']> } };
}

const passkeyOrigin = (ctx: RunRequestContext): RunReply | undefined =>
  new URL(ctx.origin).hostname === RUN_RP_ID
    ? undefined
    : refuse(409, `Passkeys work from ${ctx.origin.replace('127.0.0.1', RUN_RP_ID)}: open the glass there.`);

/** Answer one run request. */
export async function handleRunRequest(kind: RunRequestKind, payload: unknown, ctx: RunRequestContext): Promise<RunReply> {
  const wrongOrigin = ['run-passkey-challenge', 'run-passkey-register', 'run-challenge', 'run'].includes(kind)
    ? passkeyOrigin(ctx)
    : undefined;
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
            ...(existing.length
              ? { existingChallenge: ctx.challenges.issue({ kind: 'existing' }), credentialIds: existing.map((k) => k.credentialId) }
              : {}),
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
          body: {
            ok: true,
            challenge: ctx.challenges.issue({ kind: 'run', key: card.meta.key, sha256: card.meta.run.scriptSha256 }),
            rpId: RUN_RP_ID,
            credentialIds: readRunPasskeys(ctx.passkeysFile).map((k) => k.credentialId),
          },
        };
      }
      case 'run': {
        // Every check before anything runs: the passkey, the card, the hash it signed, the stored copy, the inputs.
        const verified = verifyRunAssertion(p as unknown as AssertionResponse, ctx.challenges, ctx.origin, ctx.passkeysFile);
        if (verified.key !== p.key) return refuse(403, 'The passkey signed a different card.');
        const card = runnableCard(p.key);
        if ('status' in card) return card;
        if (verified.sha256 !== card.meta.run.scriptSha256) return refuse(409, "The passkey signed a script that is not the card's.");
        if (ctx.runs.get(card.meta.key)?.attempt.state === 'running') return refuse(409, 'This card is already running.');
        const input = runStdin(card.meta.run, p.inputs);
        if ('reason' in input) return refuse(400, input.reason);
        void ctx.runs.start(card.meta, input.values, input.stdin, verified.credentialId, { maxBytes: ctx.maxBytes });
        return { status: 202, body: { ok: true, running: true, key: card.meta.key } };
      }
      case 'run-line': {
        // A line only reaches the card's own live run, from the page that holds the token.
        const refused = ctx.runs.sendLine(typeof p.key === 'string' ? p.key : '', p.line, p.secret === true);
        return refused ? refuse(409, refused) : { status: 200, body: { ok: true } };
      }
      case 'run-stop': {
        const refused = ctx.runs.stop(typeof p.key === 'string' ? p.key : '');
        return refused ? refuse(409, refused) : { status: 202, body: { ok: true } };
      }
      case 'run-dismiss': {
        const card = runnableCard(p.key);
        if ('status' in card) return card;
        if (!ctx.runs.get(card.meta.key)?.result) return refuse(409, 'Stop the command before dismissing this card.');
        withdrawDecision(card.meta.key);
        return { status: 200, body: { ok: true } };
      }
      case 'run-output': {
        const key = typeof p.key === 'string' ? p.key : '';
        const live = ctx.runs.get(key);
        if (!live) return refuse(404, 'No run for that card on this glass.');
        const after = p.id && p.id !== live.attempt.id ? 0 : typeof p.after === 'number' && p.after >= 0 ? p.after : 0;
        const from = Math.max(0, after - live.dropped);
        return {
          status: 200,
          body: {
            ok: true,
            id: live.attempt.id,
            state: live.attempt.state,
            startedAt: live.attempt.startedAt,
            finishedAt: live.attempt.finishedAt,
            warning: live.error,
            text: live.output.slice(from),
            next: live.dropped + live.output.length,
            ...(live.result ? { result: live.result } : {}),
          },
        };
      }
    }
  } catch (err) {
    if (err instanceof PasskeyError) return refuse(err.status, err.message);
    throw err;
  }
}
