/**
 * A run card's inputs as the page sends them (ume 2ec9c88b-193, intent
 * hosted-secrets). Pure, with no Node dependency, so the page and the boat
 * share one definition.
 *
 * On the hosted glass a secret input is sealed to the boat's key in the page:
 * ECDH between a fresh P-256 key and the boat's, HKDF-SHA256 with
 * `RUN_SEAL_INFO`, then AES-256-GCM. The wharf relays the sealed value and
 * can't open it. A run challenge binds the sha256 of `runInputsText`, so a
 * relayed Run can't swap the inputs the person confirmed.
 */

/** A secret input sealed to the boat's key, all base64url. */
export interface SealedInput {
  /** The page's one-time P-256 public key, SPKI DER. */
  epk: string;
  /** The 12-byte AES-GCM IV. */
  iv: string;
  /** The AES-GCM ciphertext, its 16-byte tag at the end. */
  ct: string;
}

/** A run's inputs: plain text, or sealed for a secret one on the hosted glass. */
export type RunInputValues = Record<string, string | SealedInput>;

/** The HKDF info that names what a sealed key is for. */
export const RUN_SEAL_INFO = 'lobstah run input v1';

export function isSealedInput(value: unknown): value is SealedInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (['epk', 'iv', 'ct'] as const).every((k) => typeof v[k] === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(v[k] as string)) && Object.keys(v).length === 3;
}

/** The inputs in one fixed text, by name: what the run challenge binds by its sha256. */
export function runInputsText(inputs: RunInputValues): string {
  return JSON.stringify(
    Object.keys(inputs)
      .sort()
      .map((name) => {
        const v = inputs[name]!;
        return typeof v === 'string' ? [name, v] : [name, v.epk, v.iv, v.ct];
      }),
  );
}
