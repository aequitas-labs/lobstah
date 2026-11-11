import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { HttpError, json } from './api.js';
import { html } from './common.js';
import logo from '../../../../docs/assets/favicon.png';

/**
 * Pairing a phone's passkey with a boat (ume 2ec9c88b-193, intent
 * run-access): `/passkey?boat=<name>&pair=<code>`, the link
 * `lobstah run passkey add --hosted` opens. The page asks the boat, through
 * the wharf's relay, for a challenge under the pairing code, makes a passkey
 * for this host, and sends it back the same way. The boat stores it only
 * under the code it issued; the wharf relays but can't make one.
 */

type Step = 'ready' | 'working' | 'paired' | 'failed' | 'unusable' | 'unsupported';

const b64u = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64u = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** How long a relayed call waits for its boat in all. */
const RELAY_WAIT_MS = 60_000;

/** One relayed write to a boat, waited for: the boat's own status and answer. */
async function relay(boat: string, kind: string, payload: unknown): Promise<{ status: number; body: { ok?: boolean; reason?: string; challenge?: string; rpId?: string } }> {
  const id = crypto.randomUUID();
  let response = await fetch('/api/glass/mirror/relay', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, boat, write: { kind, payload } }),
  });
  const deadline = Date.now() + RELAY_WAIT_MS;
  while (response.status === 202 && response.headers.get('X-Lobstah-Mirror-Call') !== 'answered' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    response = await fetch(`/api/glass/mirror/calls/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
  }
  if (response.status === 202) return { status: 504, body: { ok: false, reason: "The boat didn't answer. Check that it's on, then try again." } };
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export function PasskeyPairing({ signedOut }: { signedOut: (status: 401 | 403) => void }) {
  const params = new URLSearchParams(location.search);
  const boatName = params.get('boat')?.trim() ?? '';
  const pair = params.get('pair')?.trim() ?? '';
  const supported = typeof window.PublicKeyCredential === 'function' && !!navigator.credentials?.create;
  const [step, setStep] = useState<Step>(!boatName || !pair ? 'unusable' : supported ? 'ready' : 'unsupported');
  const [reason, setReason] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  const COPY: Record<Step, { title: string; detail?: string }> = {
    ready: { title: `Pair this phone with ${boatName}`, detail: `Its passkey lets this phone run cards on ${boatName}. Each run still asks for your passkey` },
    working: { title: 'Waiting for your passkey…' },
    paired: { title: 'This phone is paired', detail: `It can now run cards on ${boatName}` },
    failed: { title: "Pairing didn't finish", detail: reason || 'Try again, or run lobstah run passkey add --hosted on the Mac for a new link' },
    unusable: { title: "This pairing link doesn't work", detail: 'Run lobstah run passkey add --hosted on the Mac for a new link' },
    unsupported: { title: "This browser can't make passkeys", detail: 'Open the link in Safari or Chrome' },
  };
  useLayoutEffect(() => {
    document.title = `${COPY[step].title} · lobstah spyglass`;
    if (step !== 'working') heading.current?.focus({ preventScroll: true });
  }, [step]);

  const fail = (why: string) => {
    setReason(why);
    setStep('failed');
  };

  const start = async () => {
    setStep('working');
    try {
      const { boats } = await json<{ boats?: Array<{ boat: string; name: string }> }>('/api/glass/mirror');
      const boat = boats?.find((b) => b.name === boatName)?.boat;
      if (!boat) return fail(`${boatName} isn't mirroring to this glass. Check that it's on, then try again`);
      const asked = await relay(boat, 'run-pair-challenge', { pair });
      if (asked.status !== 200 || !asked.body.challenge || !asked.body.rpId) return fail(asked.body.reason ?? "The boat couldn't start pairing. Try again");
      const created = (await navigator.credentials.create({
        publicKey: {
          rp: { id: asked.body.rpId, name: 'lobstah glass' },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `run cards on ${boatName}`, displayName: `lobstah run cards on ${boatName}` },
          challenge: fromB64u(asked.body.challenge),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
          attestation: 'none',
          timeout: 120_000,
        },
      })) as PublicKeyCredential | null;
      if (!created) return fail('No passkey was made. Try again');
      const response = created.response as AuthenticatorAttestationResponse;
      const publicKey = response.getPublicKey();
      if (!publicKey) return fail("This passkey can't be used here. Try again with Face ID or Touch ID");
      const registration = {
        credentialId: b64u(created.rawId),
        clientDataJSON: b64u(response.clientDataJSON),
        authenticatorData: b64u(response.getAuthenticatorData()),
        publicKey: b64u(publicKey),
        alg: response.getPublicKeyAlgorithm(),
      };
      const stored = await relay(boat, 'run-pair-register', { pair, registration });
      if (stored.status !== 201) return fail(stored.body.reason ?? "The boat didn't take the passkey. Try again");
      setStep('paired');
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return signedOut(e.status);
      // The person closed the passkey prompt, or the browser refused it.
      fail(e instanceof DOMException && e.name === 'NotAllowedError' ? 'No passkey was made. Try again' : 'Something went wrong. Try again');
    }
  };

  const copy = COPY[step];
  const body =
    step === 'ready'
      ? html`<div class="auth-consent-actions"><button class="auth-github auth-consent-primary" onClick=${() => void start()}>Make a passkey</button></div>`
      : step === 'failed'
        ? html`<div class="auth-consent-actions"><button class="auth-github auth-consent-primary" onClick=${() => void start()}>Try again</button></div>`
        : step === 'paired'
          ? html`<a class="auth-consent-link" href="/">Open the glass</a>`
          : null;
  return html`<div class="auth-shell"><header class="auth-brand"><img src=${logo} width="64" height="64" alt="Lobstah lobster and star" /><b>lobstah spyglass</b></header><main class="auth-main auth-consent-main"><section class="auth-card auth-consent-card" aria-labelledby="auth-title" aria-busy=${step === 'working'}><div class="auth-card-body"><h2 id="auth-title" ref=${heading} tabindex="-1" role=${step === 'working' ? 'status' : undefined}>${copy.title}</h2>${copy.detail && html`<p id="auth-detail" class="auth-detail">${copy.detail}</p>`}${body}</div></section></main><footer class="auth-footer">Nobody stares at the water</footer></div>`;
}
