import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from '@lobstah/core';

/**
 * Pairing a phone's passkey with this boat (ume 2ec9c88b-193, intent
 * run-access). `lobstah run passkey add --hosted`, after the macOS
 * administrator dialog, issues one pairing code and opens the hosted glass's
 * pairing page with it. The page makes a passkey for the hosted glass and
 * sends it, through the wharf's relay, with the code. The boat stores the
 * passkey only under the code it issued, within five minutes, once.
 *
 * The code alone pairs nothing: the passkey's own client data must name the
 * hosted glass's origin, which only a page served from it can produce. The
 * wharf relays the code and the registration but can't make a passkey.
 */

/** How long a pairing code may be used. */
export const PAIRING_MS = 5 * 60_000;

/** The pairing waiting for its phone: the code's hash, never the code, and the hosted glass it is for. */
interface PendingPairing {
  codeHash: string;
  /** The hosted glass's origin (`https://glass.lobstah.dev`): the passkey's client data must name it. */
  origin: string;
  /** Its host name: the passkey's relying party. */
  rpId: string;
  issuedAt: string;
}

export function pairingFile(): string {
  return path.join(lobstahHome(), 'run', 'pairing.json');
}

const hash = (code: string): string => createHash('sha256').update(code).digest('base64url');

/** A hosted glass's origin, as the wharf named it: https, or http on this machine for tests. */
export function pairingOrigin(value: string): { origin: string; rpId: string } | undefined {
  try {
    const u = new URL(value);
    const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.origin !== value || (u.protocol !== 'https:' && !loopback)) return undefined;
    return { origin: u.origin, rpId: u.hostname };
  } catch {
    return undefined;
  }
}

/** Issue a pairing code for this hosted glass. A newer code replaces any older one. */
export function issuePairing(glassOrigin: string, now = Date.now(), file = pairingFile()): string {
  const target = pairingOrigin(glassOrigin);
  if (!target) throw new Error(`${glassOrigin} is not a hosted glass address`);
  const code = randomBytes(18).toString('base64url');
  const pending: PendingPairing = { codeHash: hash(code), origin: target.origin, rpId: target.rpId, issuedAt: new Date(now).toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  atomicRenameSync(tmp, file);
  return code;
}

/** The pairing a code names, while it is fresh; otherwise undefined. */
export function pendingPairing(code: unknown, now = Date.now(), file = pairingFile()): Omit<PendingPairing, 'codeHash'> | undefined {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return undefined;
  let pending: PendingPairing;
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingPairing;
  } catch {
    return undefined;
  }
  const given = Buffer.from(hash(code));
  const stored = Buffer.from(String(pending.codeHash));
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return undefined;
  if (now - Date.parse(pending.issuedAt) > PAIRING_MS) return undefined;
  return { origin: pending.origin, rpId: pending.rpId, issuedAt: pending.issuedAt };
}

/** Spend the pairing: its code works once. */
export function endPairing(file = pairingFile()): void {
  fs.rmSync(file, { force: true });
}
