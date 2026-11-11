import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from '@lobstah/core';

/**
 * The passkey that confirms a run card's Run (ume 3ef69c1d-026, intent
 * run-passkey). The glass's page token is in the page any local process can
 * fetch, so it can't tell Chris from an agent; a WebAuthn assertion with user
 * verification (Touch ID) can. The relying party is `localhost`, since an IP
 * address can't be a WebAuthn RP ID: the glass answers at
 * `http://localhost:<port>` as well as 127.0.0.1, and a passkey works only
 * from the localhost page.
 *
 * Verification is plain WebAuthn with ES256, done with node:crypto: the
 * client data names the right ceremony, challenge and origin; the
 * authenticator data names this RP and says the user was present and
 * verified; and the signature over both verifies with the registered public
 * key. Each challenge is single-use and lasts two minutes.
 */

/** The WebAuthn relying party: the glass page's host name. */
export const RUN_RP_ID = 'localhost';
/** COSE ES256, the one algorithm a run passkey may use. */
export const ES256 = -7;
/** How long a challenge may be answered. */
export const RUN_CHALLENGE_MS = 120_000;

/** A registered run passkey. Only its public half is stored. */
export interface RunPasskey {
  /** base64url credential id. */
  credentialId: string;
  /** base64url SPKI DER of the P-256 public key. */
  publicKey: string;
  alg: number;
  createdAt: string;
  signCount: number;
}

/** A refused registration or assertion; `status` is the HTTP status the glass answers with. */
export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

export function runPasskeysFile(): string {
  return path.join(lobstahHome(), 'run', 'passkeys.json');
}

/**
 * The passkeys a phone paired for the hosted glass (ume 2ec9c88b-193, intent
 * run-access): made for the hosted glass's host name, not localhost, and
 * kept apart from the Mac's own so neither can stand in for the other.
 */
export function hostedPasskeysFile(): string {
  return path.join(lobstahHome(), 'run', 'hosted-passkeys.json');
}

export function readRunPasskeys(file = runPasskeysFile()): RunPasskey[] {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as RunPasskey[];
    return Array.isArray(list) ? list.filter((k) => typeof k.credentialId === 'string' && typeof k.publicKey === 'string') : [];
  } catch {
    return [];
  }
}

/** How many run passkeys are registered, and when the newest was: what the glass shows. */
export function runPasskeyStatus(file = runPasskeysFile()): { count: number; newestAt?: string } {
  const list = readRunPasskeys(file);
  const newestAt = list.map((k) => k.createdAt).sort().at(-1);
  return { count: list.length, ...(newestAt ? { newestAt } : {}) };
}

function writeRunPasskeys(list: RunPasskey[], file = runPasskeysFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  atomicRenameSync(tmp, file);
}

/**
 * What a challenge was issued for: a registration, the current passkey's
 * consent to another one (`existing`), or one card's Run over the script hash
 * the page showed.
 */
export type ChallengeScope =
  | { kind: 'register' }
  | { kind: 'existing' }
  | { kind: 'run'; key: string; sha256: string }
  /** A phone's passkey for the hosted glass, made under one pairing code. */
  | { kind: 'pair'; code: string };

interface IssuedChallenge {
  scope: ChallengeScope;
  issuedAt: number;
}

/**
 * Challenges the glass server issued and not yet spent, in memory: a
 * restarted glass forgets them, which only means asking again.
 */
export class RunChallenges {
  private readonly issued = new Map<string, IssuedChallenge>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh 32-byte challenge, base64url, for this scope. */
  issue(scope: ChallengeScope): string {
    this.prune();
    const challenge = randomBytes(32).toString('base64url');
    this.issued.set(challenge, { scope, issuedAt: this.now() });
    return challenge;
  }

  /** Spend a challenge: its scope, once, while it is fresh; otherwise undefined. */
  spend(challenge: string): ChallengeScope | undefined {
    const hit = this.issued.get(challenge);
    this.issued.delete(challenge);
    if (!hit || this.now() - hit.issuedAt > RUN_CHALLENGE_MS) return undefined;
    return hit.scope;
  }

  private prune(): void {
    for (const [c, v] of this.issued) if (this.now() - v.issuedAt > RUN_CHALLENGE_MS) this.issued.delete(c);
  }
}

const b64u = (value: unknown, what: string): Buffer => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384) throw new PasskeyError(`${what} is not base64url`, 400);
  return Buffer.from(value, 'base64url');
};

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function readClientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', origin: string): ClientData {
  let data: ClientData;
  try {
    data = JSON.parse(raw.toString('utf8')) as ClientData;
  } catch {
    throw new PasskeyError('client data is not JSON', 400);
  }
  if (data.type !== type) throw new PasskeyError(`client data is not a ${type}`);
  if (data.origin !== origin) throw new PasskeyError(`passkey origin ${String(data.origin)} is not ${origin}`);
  if (data.crossOrigin === true) throw new PasskeyError('a cross-origin ceremony is refused');
  if (typeof data.challenge !== 'string') throw new PasskeyError('client data has no challenge', 400);
  return data;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface AuthenticatorData {
  flags: number;
  signCount: number;
  /** The attested credential id, on a registration. */
  credentialId?: Buffer;
}

function readAuthenticatorData(raw: Buffer, rpId = RUN_RP_ID): AuthenticatorData {
  if (raw.length < 37) throw new PasskeyError('authenticator data is too short', 400);
  const rpIdHash = raw.subarray(0, 32);
  if (!rpIdHash.equals(createHash('sha256').update(rpId).digest())) throw new PasskeyError(`the passkey is not for ${rpId}`);
  const flags = raw[32]!;
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) throw new PasskeyError('the passkey did not verify the user (Touch ID or the device password)');
  const signCount = raw.readUInt32BE(33);
  if (!(flags & FLAG_AT)) return { flags, signCount };
  if (raw.length < 55) throw new PasskeyError('attested credential data is too short', 400);
  const idLength = raw.readUInt16BE(53);
  if (raw.length < 55 + idLength) throw new PasskeyError('attested credential id is cut short', 400);
  return { flags, signCount, credentialId: raw.subarray(55, 55 + idLength) };
}

/** What the page sends after `navigator.credentials.create()`. */
export interface RegistrationResponse {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  /** `response.getPublicKey()`: SPKI DER, base64url. */
  publicKey: string;
  /** `response.getPublicKeyAlgorithm()`. */
  alg: number;
}

/**
 * Check a registration against a challenge this server issued for one, and
 * return the passkey to store. The ceremony's challenge is spent here.
 */
export function verifyRegistration(
  res: RegistrationResponse,
  challenges: RunChallenges,
  origin: string,
  now = new Date(),
  /** A hosted pairing: its relying party, and the scope its challenge must have been issued for. */
  hosted?: { rpId: string; scope: (scope: ChallengeScope) => boolean },
): RunPasskey {
  if (!res || typeof res !== 'object') throw new PasskeyError('a passkey registration is required', 400);
  const clientData = readClientData(b64u(res.clientDataJSON, 'clientDataJSON'), 'webauthn.create', origin);
  const scope = challenges.spend(clientData.challenge);
  if (!scope || !(hosted ? hosted.scope(scope) : scope.kind === 'register')) throw new PasskeyError('the registration challenge is unknown, spent or older than two minutes');
  if (res.alg !== ES256) throw new PasskeyError('a run passkey must use ES256 (P-256)', 400);
  const id = b64u(res.credentialId, 'credentialId');
  const auth = readAuthenticatorData(b64u(res.authenticatorData, 'authenticatorData'), hosted?.rpId);
  if (!auth.credentialId?.equals(id)) throw new PasskeyError('the attested credential is not the one registered', 400);
  const spki = b64u(res.publicKey, 'publicKey');
  let key;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new PasskeyError('the public key is not SPKI DER', 400);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new PasskeyError('a run passkey must be a P-256 key', 400);
  return { credentialId: res.credentialId, publicKey: res.publicKey, alg: ES256, createdAt: now.toISOString(), signCount: auth.signCount };
}

/** Store a verified passkey beside any others, replacing one with the same credential id. */
export function addRunPasskey(passkey: RunPasskey, file = runPasskeysFile()): void {
  writeRunPasskeys([...readRunPasskeys(file).filter((k) => k.credentialId !== passkey.credentialId), passkey], file);
}

/** What the page sends after `navigator.credentials.get()`. */
export interface AssertionResponse {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  /** DER ECDSA signature, base64url. */
  signature: string;
}

/**
 * Check an assertion: a registered passkey signed a challenge this server
 * issued for `kind`, not yet spent and under two minutes old, with the user
 * verified. The challenge is spent whether or not the rest verifies. Returns
 * what the challenge was issued for, and the passkey that signed.
 */
function verifyAssertion<K extends 'run' | 'existing'>(
  res: AssertionResponse,
  challenges: RunChallenges,
  origin: string,
  kind: K,
  file: string,
): { scope: Extract<ChallengeScope, { kind: K }>; credentialId: string } {
  // No assertion is no confirmation: refused as unauthorized, like a wrong one.
  if (!res || typeof res !== 'object' || (['credentialId', 'clientDataJSON', 'authenticatorData', 'signature'] as const).some((f) => typeof res[f] !== 'string'))
    throw new PasskeyError('a passkey assertion is required');
  const clientRaw = b64u(res.clientDataJSON, 'clientDataJSON');
  const clientData = readClientData(clientRaw, 'webauthn.get', origin);
  const scope = challenges.spend(clientData.challenge);
  if (scope?.kind !== kind) throw new PasskeyError(`the ${kind === 'run' ? 'run' : 'passkey'} challenge is unknown, spent or older than two minutes`);
  const passkeys = readRunPasskeys(file);
  const passkey = passkeys.find((k) => k.credentialId === res.credentialId);
  if (!passkey) throw new PasskeyError('that passkey is not registered for runs');
  const authRaw = b64u(res.authenticatorData, 'authenticatorData');
  const auth = readAuthenticatorData(authRaw);
  const signed = Buffer.concat([authRaw, createHash('sha256').update(clientRaw).digest()]);
  const key = createPublicKey({ key: Buffer.from(passkey.publicKey, 'base64url'), format: 'der', type: 'spki' });
  if (!verifySignature('sha256', signed, key, b64u(res.signature, 'signature'))) throw new PasskeyError('the passkey signature does not verify');
  // A counter that went backwards means a cloned authenticator; synced passkeys keep 0.
  if (auth.signCount !== 0 || passkey.signCount !== 0) {
    if (auth.signCount <= passkey.signCount) throw new PasskeyError('the passkey counter went backwards');
    writeRunPasskeys(passkeys.map((k) => (k.credentialId === passkey.credentialId ? { ...k, signCount: auth.signCount } : k)), file);
  }
  return { scope: scope as Extract<ChallengeScope, { kind: K }>, credentialId: passkey.credentialId };
}

/** A Run's assertion: returns the card and the script hash the passkey signed for. */
export function verifyRunAssertion(res: AssertionResponse, challenges: RunChallenges, origin: string, file = runPasskeysFile()): { key: string; sha256: string; credentialId: string } {
  const { scope, credentialId } = verifyAssertion(res, challenges, origin, 'run', file);
  return { key: scope.key, sha256: scope.sha256, credentialId };
}

/** A current passkey's consent to registering another: an assertion over an `existing` challenge. */
export function verifyExistingPasskey(res: AssertionResponse, challenges: RunChallenges, origin: string, file = runPasskeysFile()): string {
  return verifyAssertion(res, challenges, origin, 'existing', file).credentialId;
}

/** What the macOS dialog says. It names the action, so a prompt nobody asked for stands out. */
export const PASSKEY_DIALOG_PROMPT = 'lobstah glass wants to register a passkey that confirms run cards. Allow it only if you just pressed Register in the glass.';
/** The dialog before a phone may pair: it names the hosted glass, so a prompt nobody asked for stands out. */
export const HOSTED_PASSKEY_DIALOG_PROMPT =
  'lobstah wants to let a phone confirm run cards on this Mac from the hosted glass. Allow it only if you just ran lobstah run passkey add --hosted.';

/** Runs a command and resolves to its exit code (0 for success). */
export type ExitOf = (command: string, args: string[]) => Promise<number>;

const exitOf: ExitOf = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 120_000 }, (err) => resolve(err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0));
  });

/**
 * Chris's go-ahead to store a passkey (ume f81321ac-e3d): macOS's own
 * administrator dialog, which a process holding the page token can't
 * answer. Resolves to why it was refused, or undefined when allowed.
 */
export function macPasswordGate(run: ExitOf = exitOf, platform: NodeJS.Platform = process.platform, prompt = PASSKEY_DIALOG_PROMPT): () => Promise<string | undefined> {
  return async () => {
    if (platform !== 'darwin') return 'Run passkeys are registered on macOS, with its password dialog.';
    const script = `do shell script "/usr/bin/true" with prompt ${JSON.stringify(prompt)} with administrator privileges`;
    return (await run('/usr/bin/osascript', ['-e', script])) === 0 ? undefined : "The macOS password wasn't given, so the passkey was not stored.";
  };
}
