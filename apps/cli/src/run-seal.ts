import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { RUN_SEAL_INFO, atomicRenameSync, isSealedInput, lobstahHome, uniqueTempPath } from '@lobstah/core';
import type { RunCard, RunInputValues } from '@lobstah/core';
import { PasskeyError } from './run-passkey.js';

/**
 * The boat's key for secret inputs typed on the hosted glass (ume
 * 2ec9c88b-193, intent hosted-secrets). Its public half goes on each run card
 * in the snapshot; its private half stays in ~/.lobstah/run/seal-key.pem,
 * mode 0600, and never leaves this machine. The page seals each secret to it
 * (ECDH, HKDF-SHA256, AES-256-GCM), so the wharf's storage and logs only
 * ever hold sealed values.
 */

export function sealKeyFile(): string {
  return path.join(lobstahHome(), 'run', 'seal-key.pem');
}

let cached: { file: string; privateKey: KeyObject; publicKey: string } | undefined;

/** This boat's seal key, made the first time it is asked for. */
export function runSealKey(file = sealKeyFile()): { privateKey: KeyObject; publicKey: string } {
  if (cached?.file === file && fs.existsSync(file)) return cached;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(fs.readFileSync(file, 'utf8'));
  } catch {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = pair.privateKey;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    atomicRenameSync(tmp, file);
  }
  const publicKey = (createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
  cached = { file, privateKey, publicKey };
  return cached;
}

/** Open one sealed input with this boat's key, or refuse it. */
export function openSealedInput(sealed: unknown, privateKey: KeyObject): string {
  if (!isSealedInput(sealed)) throw new PasskeyError('A sealed input is malformed.', 400);
  try {
    const peer = createPublicKey({ key: Buffer.from(sealed.epk, 'base64url'), format: 'der', type: 'spki' });
    if (peer.asymmetricKeyType !== 'ec' || peer.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not P-256');
    const shared = diffieHellman({ privateKey, publicKey: peer });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), RUN_SEAL_INFO, 32));
    const iv = Buffer.from(sealed.iv, 'base64url');
    const ct = Buffer.from(sealed.ct, 'base64url');
    if (iv.length !== 12 || ct.length < 17) throw new Error('short');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new PasskeyError("A sealed input couldn't be opened on this boat.", 400);
  }
}

/**
 * The inputs as the run reads them. From the hosted glass every secret input
 * must arrive sealed; a text input may come plain. On the Mac's own page
 * inputs come plain, as before.
 */
export function openRunInputs(card: RunCard, inputs: unknown, relayed: boolean, privateKey?: KeyObject): Record<string, string> | { reason: string } {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return { reason: 'The inputs are required.' };
  const given = inputs as RunInputValues;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(given)) {
    const declared = card.inputs.find((i) => i.name === name);
    if (typeof value === 'string') {
      if (relayed && declared?.secret) return { reason: 'Secret inputs must be sealed to the boat.' };
      out[name] = value;
    } else if (isSealedInput(value)) {
      out[name] = openSealedInput(value, privateKey ?? runSealKey().privateKey);
    } else return { reason: `${name} is malformed.` };
  }
  return out;
}
