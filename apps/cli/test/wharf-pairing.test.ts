import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_SCRIPT, GLASS_CSS } from '../../../services/wharf/src/glass-page.generated.js';
import { authDestination } from '../../../services/wharf/glass/src/auth-screen.js';
import { snapshot } from './fixtures/wharf-glass.js';

/**
 * The hosted glass's pairing page (ume 2ec9c88b-193, intent run-access):
 * `/passkey?boat=<name>&pair=<code>` asks the boat for a challenge through
 * the relay, makes a passkey for this host, and sends it back the same way.
 */

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.map((w) => w.happyDOM.close()));
  windows.length = 0;
});

type Relayed = { boat: string; write: { kind: string; payload: Record<string, unknown> } };
type Answer = (call: Relayed) => { status: number; body: unknown };

const challenge = Buffer.from('challenge-bytes-0123456789abcdef').toString('base64url');
const okAnswer: Answer = (call) =>
  call.write.kind === 'run-pair-challenge' ? { status: 200, body: { ok: true, challenge, rpId: 'glass.test' } } : { status: 201, body: { ok: true } };

async function page(path: string, opts: { answer?: Answer; webauthn?: boolean; created?: () => unknown } = {}) {
  const window = new Window({ url: 'https://glass.test' + path, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  windows.push(window);
  const relayed: Relayed[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const w = window as unknown as Record<string, unknown>;
  w.setInterval = () => 0;
  w.clearInterval = () => {};
  w.WebSocket = class { close() {} };
  if (opts.webauthn !== false) {
    w.PublicKeyCredential = class {};
    const bytes = (text: string) => new TextEncoder().encode(text).buffer;
    Object.defineProperty(window.navigator, 'credentials', {
      configurable: true,
      value: {
        create: async (options: { publicKey: Record<string, unknown> }) => {
          asked.push(options.publicKey);
          if (opts.created) return opts.created();
          return {
            rawId: bytes('cred-1'),
            response: {
              clientDataJSON: bytes('{"type":"webauthn.create"}'),
              getAuthenticatorData: () => bytes('auth-data'),
              getPublicKey: () => bytes('spki'),
              getPublicKeyAlgorithm: () => -7,
            },
          };
        },
      },
    });
  }
  w.fetch = async (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST' && url === '/api/glass/mirror/relay') {
      const call = JSON.parse(String(init.body)) as Relayed;
      relayed.push(call);
      const answer = (opts.answer ?? okAnswer)(call);
      return Response.json(answer.body, { status: answer.status, headers: { 'X-Lobstah-Mirror-Call': 'answered' } });
    }
    if (url === '/api/glass/mirror') return Response.json({ boats: [{ boat: 'b-1', name: 'studio' }] });
    return Response.json(url === '/api/glass' ? snapshot : []);
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(`<!doctype html><html><head><meta name="lobstah-session" content="in"><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`);
  await settle();
  const text = (sel: string) => window.document.querySelector(sel)?.textContent ?? '';
  const click = async (label: string) => {
    const button = [...window.document.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    expect(button, label).toBeTruthy();
    button!.click();
    await settle();
  };
  return { doc: window.document, relayed, asked, text, click };
}

describe('the pairing page', () => {
  it('asks the named boat for a challenge, makes a passkey for this host, and sends it back under the code', async () => {
    const g = await page('/passkey?boat=studio&pair=PAIRCODE0123456789ab');
    expect(g.text('#auth-title')).toBe('Pair this phone with studio');
    await g.click('Make a passkey');
    expect(g.relayed.map((c) => [c.boat, c.write.kind])).toEqual([
      ['b-1', 'run-pair-challenge'],
      ['b-1', 'run-pair-register'],
    ]);
    expect(g.relayed[0]!.write.payload).toEqual({ pair: 'PAIRCODE0123456789ab' });
    // A passkey for this host, ES256, with the user verified.
    const asked = g.asked[0]!;
    expect((asked.rp as { id: string }).id).toBe('glass.test');
    expect(asked.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect((asked.authenticatorSelection as { userVerification: string }).userVerification).toBe('required');
    expect(Buffer.from(asked.challenge as Uint8Array).toString('base64url')).toBe(challenge);
    const sent = g.relayed[1]!.write.payload as { pair: string; registration: Record<string, unknown> };
    expect(sent.pair).toBe('PAIRCODE0123456789ab');
    expect(sent.registration).toMatchObject({ credentialId: Buffer.from('cred-1').toString('base64url'), alg: -7 });
    expect(g.text('#auth-title')).toBe('This phone is paired');
    expect(g.text('#auth-detail')).toBe('It can now run cards on studio');
  });

  it("shows the boat's reason when it refuses, and offers to try again", async () => {
    const g = await page('/passkey?boat=studio&pair=PAIRCODE0123456789ab', {
      answer: () => ({ status: 403, body: { ok: false, reason: 'This pairing link has expired or was used. Run lobstah run passkey add --hosted on the Mac again.' } }),
    });
    await g.click('Make a passkey');
    expect(g.text('#auth-title')).toBe("Pairing didn't finish");
    expect(g.text('#auth-detail')).toContain('run passkey add --hosted');
    expect(g.asked).toEqual([]);
    expect([...g.doc.querySelectorAll('button')].map((b) => b.textContent)).toContain('Try again');
  });

  it('says so when the boat is not mirroring, the link is incomplete, or the browser has no passkeys', async () => {
    const away = await page('/passkey?boat=mini&pair=PAIRCODE0123456789ab');
    await away.click('Make a passkey');
    expect(away.text('#auth-detail')).toBe("mini isn't mirroring to this glass. Check that it's on, then try again");
    expect(away.relayed).toEqual([]);
    const broken = await page('/passkey?boat=studio');
    expect(broken.text('#auth-title')).toBe("This pairing link doesn't work");
    const old = await page('/passkey?boat=studio&pair=PAIRCODE0123456789ab', { webauthn: false });
    expect(old.text('#auth-title')).toBe("This browser can't make passkeys");
  });

  it('returns to the pairing link after sign-in', () => {
    const back = authDestination({ href: '', origin: 'https://glass.test', pathname: '/api/auth/error', search: '?returnTo=' + encodeURIComponent('/passkey?boat=studio&pair=X') });
    expect(back.href).toBe('https://glass.test/passkey?boat=studio&pair=X');
  });
});
