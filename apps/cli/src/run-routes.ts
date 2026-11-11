import { decisionDir, readDecision, readDecisionAnswer, readStoredRunScript, withdrawDecision } from '@lobstah/core';
import type { DecisionMeta } from '@lobstah/core';
import {
  PasskeyError,
  RUN_RP_ID,
  RunChallenges,
  addRunPasskey,
  hostedPasskeysFile,
  readRunPasskeys,
  verifyExistingPasskey,
  verifyHostedRunAssertion,
  verifyRegistration,
  verifyRunAssertion,
  type AssertionResponse,
  type RegistrationResponse,
} from './run-passkey.js';
import { RunRegistry, runStdin } from './run-exec.js';
import { endPairing, pendingPairing } from './run-pairing.js';
import { RunWindows } from './run-window.js';
import { openRunInputs } from './run-seal.js';
import { runInputsText, sha256Hex } from '@lobstah/core';
import type { RunInputValues } from '@lobstah/core';

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
  'run-pair-challenge',
  'run-pair-register',
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
  /** Where a phone's hosted-glass passkeys and the pending pairing live; the defaults under ~/.lobstah/run. */
  hostedPasskeysFile?: string;
  pairingFile?: string;
  /** The runs this server started. */
  runs: RunRegistry;
  /**
   * The call came from the hosted glass through the wharf's relay. A Run
   * then needs a phone's passkey (paired for the hosted glass) or that
   * page's window key; the Mac's own passkey never confirms a relayed Run.
   */
  relayed?: boolean;
  /** The 15-minute windows this glass opened. */
  windows: RunWindows;
  /** Per-file answer limit (limits.attachmentMaxBytes), for the answer a run writes. */
  maxBytes: number;
}

const refuse = (status: number, reason: string): RunReply => ({ status, body: { ok: false, reason } });

const PAIRING_EXPIRED = 'This pairing link has expired or was used. Run lobstah run passkey add --hosted on the Mac again.';
const PAIR_FIRST = 'Pair this phone first: run lobstah run passkey add --hosted on the Mac.';

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
  const relayed = ctx.relayed === true;
  // The Mac's own passkey is registered only on the Mac.
  if (relayed && (kind === 'run-passkey-challenge' || kind === 'run-passkey-register')) return refuse(403, 'Set up the Mac’s passkey on the Mac.');
  const wrongOrigin = !relayed && ['run-passkey-challenge', 'run-passkey-register', 'run-challenge', 'run'].includes(kind) ? passkeyOrigin(ctx) : undefined;
  if (wrongOrigin) return wrongOrigin;
  const keysFile = relayed ? (ctx.hostedPasskeysFile ?? hostedPasskeysFile()) : ctx.passkeysFile;
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
        if (relayed && card.meta.run.interactive) return refuse(409, 'Interactive cards run from the Mac.');
        // The challenge binds the inputs the page will send, by hash: a relayed Run must, so the wharf can't swap them.
        const inputs = typeof p.inputsSha256 === 'string' && /^[a-f0-9]{64}$/.test(p.inputsSha256) ? p.inputsSha256 : undefined;
        if (relayed && !inputs) return refuse(400, "The inputs' hash is required.");
        const sha256 = card.meta.run.scriptSha256;
        // Inside the page's window, its window key signs the challenge instead of a passkey.
        const window = p.window === undefined ? undefined : ctx.windows.get(p.window, relayed);
        if (window)
          return {
            status: 200,
            body: {
              ok: true,
              challenge: ctx.challenges.issue({ kind: 'run', key: card.meta.key, sha256, window: window.id, ...(inputs ? { inputs } : {}) }),
              window: window.id,
              windowUntil: window.until,
              sha256,
            },
          };
        const keys = readRunPasskeys(keysFile);
        if (!keys.length) return refuse(409, relayed ? PAIR_FIRST : 'Set up a passkey in Settings to run cards.');
        const rpId = relayed ? keys[0]!.rpId : RUN_RP_ID;
        return {
          status: 200,
          body: {
            ok: true,
            challenge: ctx.challenges.issue({ kind: 'run', key: card.meta.key, sha256, ...(inputs ? { inputs } : {}) }),
            rpId,
            credentialIds: keys.filter((k) => !relayed || k.rpId === rpId).map((k) => k.credentialId),
            sha256,
          },
        };
      }
      case 'run': {
        // Every check before anything runs: the passkey or the window key, the card, the hash it signed, the stored copy, the inputs.
        let verified: { key: string; sha256: string; credentialId: string; inputs?: string };
        if (p.window !== undefined) {
          const scope = typeof p.challenge === 'string' ? ctx.challenges.spend(p.challenge) : undefined;
          if (scope?.kind !== 'run' || scope.window !== p.window) return refuse(403, 'The run challenge is unknown, spent or older than two minutes.');
          const credentialId = ctx.windows.verify(p.window, relayed, p.challenge as string, p.windowSignature);
          verified = { key: scope.key, sha256: scope.sha256, credentialId, ...(scope.inputs ? { inputs: scope.inputs } : {}) };
        } else
          verified = relayed
            ? verifyHostedRunAssertion(p as unknown as AssertionResponse, ctx.challenges, keysFile)
            : verifyRunAssertion(p as unknown as AssertionResponse, ctx.challenges, ctx.origin, ctx.passkeysFile);
        if (verified.key !== p.key) return refuse(403, 'The passkey signed a different card.');
        const card = runnableCard(p.key);
        if ('status' in card) return card;
        if (verified.sha256 !== card.meta.run.scriptSha256) return refuse(409, "The passkey signed a script that is not the card's.");
        if (relayed && card.meta.run.interactive) return refuse(409, 'Interactive cards run from the Mac.');
        // The inputs must be the ones the challenge bound: a relayed Run always binds them.
        if (relayed && !verified.inputs) return refuse(403, 'The inputs were not confirmed.');
        if (verified.inputs && (!p.inputs || typeof p.inputs !== 'object' || sha256Hex(runInputsText(p.inputs as RunInputValues)) !== verified.inputs))
          return refuse(403, 'The inputs are not the ones that were confirmed.');
        if (ctx.runs.get(card.meta.key)?.attempt.state === 'running') return refuse(409, 'This card is already running.');
        const plain = openRunInputs(card.meta.run, p.inputs, relayed);
        if ('reason' in plain) return refuse(400, plain.reason);
        const input = runStdin(card.meta.run, plain);
        if ('reason' in input) return refuse(400, input.reason);
        // A passkey confirmation may open the page's 15-minute window, bound to its key.
        const opened = p.window === undefined && p.windowKey !== undefined ? ctx.windows.start(p.windowKey, verified.credentialId, relayed) : undefined;
        void ctx.runs.start(card.meta, input.values, input.stdin, verified.credentialId, { maxBytes: ctx.maxBytes });
        return { status: 202, body: { ok: true, running: true, key: card.meta.key, ...(opened ? { window: opened.id, windowUntil: opened.until } : {}) } };
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
      case 'run-pair-challenge': {
        // A phone pairing from the hosted glass, through the relay: only under the code `run passkey add --hosted` issued.
        const pairing = pendingPairing(p.pair, Date.now(), ctx.pairingFile);
        if (!pairing) return refuse(403, PAIRING_EXPIRED);
        return { status: 200, body: { ok: true, challenge: ctx.challenges.issue({ kind: 'pair', code: p.pair as string }), rpId: pairing.rpId } };
      }
      case 'run-pair-register': {
        const pairing = pendingPairing(p.pair, Date.now(), ctx.pairingFile);
        if (!pairing) return refuse(403, PAIRING_EXPIRED);
        // The passkey's client data must name the hosted glass the pairing was issued for, and its challenge this pairing.
        const passkey = verifyRegistration(p.registration as RegistrationResponse, ctx.challenges, pairing.origin, new Date(), {
          rpId: pairing.rpId,
          scope: (s) => s.kind === 'pair' && s.code === p.pair,
        });
        endPairing(ctx.pairingFile);
        addRunPasskey({ ...passkey, origin: pairing.origin, rpId: pairing.rpId } as typeof passkey, ctx.hostedPasskeysFile ?? hostedPasskeysFile());
        return { status: 201, body: { ok: true, credentialId: passkey.credentialId, createdAt: passkey.createdAt } };
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
