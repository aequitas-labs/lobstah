import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests: an ES256 key whose
 * registration and assertion responses are built exactly as a browser
 * sends them, with the flags a test chooses.
 */
export class SoftPasskey {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  readonly spki: Buffer;
  private count = 0;

  constructor(
    readonly rpId = 'localhost',
    private readonly counting = false,
  ) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    this.spki = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  }

  private authData(flags: number, attested: boolean): Buffer {
    const head = Buffer.alloc(37);
    createHash('sha256').update(this.rpId).digest().copy(head, 0);
    head[32] = flags | (attested ? 0x40 : 0);
    if (this.counting) this.count += 1;
    head.writeUInt32BE(this.count, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, this.credentialId]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What the page posts after navigator.credentials.create(). */
  register(challenge: string, origin: string, flags = 0x05) {
    return {
      credentialId: this.credentialId.toString('base64url'),
      clientDataJSON: this.clientData('webauthn.create', challenge, origin).toString('base64url'),
      authenticatorData: this.authData(flags, true).toString('base64url'),
      publicKey: this.spki.toString('base64url'),
      alg: -7,
    };
  }

  /** What the page posts after navigator.credentials.get(). */
  assert(challenge: string, origin: string, flags = 0x05) {
    const auth = this.authData(flags, false);
    const client = this.clientData('webauthn.get', challenge, origin);
    const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), this.privateKey);
    return {
      credentialId: this.credentialId.toString('base64url'),
      clientDataJSON: client.toString('base64url'),
      authenticatorData: auth.toString('base64url'),
      signature: signature.toString('base64url'),
    };
  }
}
