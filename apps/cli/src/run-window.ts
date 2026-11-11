import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { PasskeyError } from './run-passkey.js';

/**
 * The 15-minute window (ume 2ec9c88b-193, intent hosted-run): one passkey
 * confirmation covers 15 minutes of runs on that page, on either glass.
 *
 * At the confirmation the page makes a P-256 signing key in WebCrypto whose
 * private half can't be exported and lives only in that page's memory, and
 * sends its public half with the passkey's Run. The boat binds the window to
 * that key. A Run inside the window is still a tap: the page signs the
 * boat's fresh challenge (bound to the card and its script hash) with the
 * window key instead of asking for Face ID. Neither the wharf, which sees
 * every relayed call, nor a process with the page token holds the private
 * key, so neither can use the window. Reloading or closing the page loses
 * the key; 15 minutes ends the window. A window opened on one glass (local
 * or hosted) works only there.
 */

export const RUN_WINDOW_MS = 15 * 60_000;

/** Whether a page key signed this text: WebCrypto's ECDSA P-256 with SHA-256, as raw r‖s. */
export function pageKeySigned(publicKey: string, text: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{80,200}$/.test(signature)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return verifySignature('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

interface OpenWindow {
  /** base64url SPKI DER of the page's P-256 public key. */
  publicKey: string;
  /** The passkey whose confirmation opened it. */
  credentialId: string;
  /** Opened from the hosted glass, through the relay. */
  hosted: boolean;
  until: number;
}

/** Windows this glass opened and not yet ended, in memory: a restarted glass ends them all. */
export class RunWindows {
  private readonly open = new Map<string, OpenWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Open a window for this page key. Returns its id and when it ends. */
  start(publicKey: unknown, credentialId: string, hosted: boolean): { id: string; until: number } {
    if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{40,400}$/.test(publicKey)) throw new PasskeyError('the window key is not base64url', 400);
    let key;
    try {
      key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    } catch {
      throw new PasskeyError('the window key is not SPKI DER', 400);
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new PasskeyError('the window key must be a P-256 key', 400);
    this.prune();
    const id = createHash('sha256').update(publicKey).digest('base64url');
    const until = this.now() + RUN_WINDOW_MS;
    this.open.set(id, { publicKey, credentialId, hosted, until });
    return { id, until };
  }

  /** The window an id names, while it lasts, on the glass it was opened on. */
  get(id: unknown, hosted: boolean): (OpenWindow & { id: string }) | undefined {
    if (typeof id !== 'string') return undefined;
    const w = this.open.get(id);
    if (!w || w.until <= this.now() || w.hosted !== hosted) return undefined;
    return { ...w, id };
  }

  /**
   * Check the page's signature over a challenge: WebCrypto's ECDSA P-256
   * with SHA-256, as raw r‖s. Returns the passkey that opened the window.
   */
  verify(id: unknown, hosted: boolean, challenge: string, signature: unknown): string {
    const w = this.get(id, hosted);
    if (!w) throw new PasskeyError('the 15-minute window has ended: confirm with your passkey');
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{80,200}$/.test(signature)) throw new PasskeyError('the window signature is not base64url', 400);
    if (!pageKeySigned(w.publicKey, challenge, signature)) throw new PasskeyError('the window signature does not verify');
    return w.credentialId;
  }

  private prune(): void {
    for (const [id, w] of this.open) if (w.until <= this.now()) this.open.delete(id);
  }
}
