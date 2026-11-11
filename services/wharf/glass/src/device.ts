import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { HttpError, json } from './api.js';
import { html, value } from './common.js';
import logo from '../../../../docs/assets/favicon.png';

/**
 * Boat approval on /device: its own consent page, not the glass. It names the
 * boat and its code, says what the boat can and cannot do, and asks Approve or
 * Deny. The terminal that asked finishes on its own once approved.
 */

type Device = { boatName?: string; previousBoatName?: string; requestedPermissions?: string[]; status?: string };
type Step =
  | { kind: 'enter' }
  | { kind: 'checking' }
  | { kind: 'review'; device: Required<Pick<Device, 'boatName' | 'requestedPermissions'>> & Device }
  | { kind: 'approved'; name: string }
  | { kind: 'denied'; name: string }
  | { kind: 'unusable' };

/** The access a person can choose for a boat: what it asked for, or less. A mirror boat is approved as it asked, or denied. */
const ACCESS: Record<string, { label: string; permissions: string[] }> = {
  mirror: { label: 'Mirror', permissions: ['mirror', 'read'] },
  helm: { label: 'Work, see and steer', permissions: ['work', 'helm'] },
  read: { label: 'Work and see', permissions: ['work', 'read'] },
  none: { label: 'Work only', permissions: ['work'] },
};

function choices(requested: string[]): string[] {
  if (requested.includes('mirror')) return ['mirror'];
  return ['helm', 'read', 'none'].filter((c) => c === 'none' || requested.includes(c) || (c === 'read' && requested.includes('helm')));
}

/** What the chosen access lets the boat do, and what it doesn't. */
function abilities(choice: string): { can: string[]; cannot: string[] } {
  if (choice === 'mirror')
    return { can: ['Show its own jobs on this glass', 'Carry out what you do here for those jobs'], cannot: ['Take work from this wharf', 'Steer the helm'] };
  const p = ACCESS[choice]!.permissions;
  const helm = p.includes('helm'),
    read = helm || p.includes('read');
  return {
    can: ['Take work from this wharf', ...(read ? ['See the grounds: jobs, decisions and reports'] : []), ...(helm ? ['Steer jobs and the helm'] : [])],
    cannot: [...(read ? [] : ['See the grounds']), ...(helm ? [] : ['Steer the helm'])],
  };
}

const COPY: Record<Exclude<Step['kind'], 'review'>, { title: string; detail?: string }> = {
  enter: { title: 'Approve a boat', detail: 'Enter the code your terminal shows' },
  checking: { title: 'Checking the code…' },
  approved: { title: 'Approved', detail: 'Your terminal finishes connecting on its own. You can close this page' },
  denied: { title: 'Denied', detail: 'Nothing was connected. You can close this page' },
  unusable: { title: "This code doesn't work", detail: 'It may have expired or already been used. Start again from your terminal' },
};

export function DeviceConsent({ signedOut }: { signedOut: (status: 401 | 403) => void }) {
  const initial = new URLSearchParams(location.search).get('user_code')?.trim() ?? '';
  const [code, setCode] = useState(initial);
  const [step, setStep] = useState<Step>(initial ? { kind: 'checking' } : { kind: 'enter' });
  const [choice, setChoice] = useState('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  // Only a lost session signs out. The wharf refuses a code it won't take (used, expired, another
  // account's) with a 4xx, 403 included: that code doesn't work, and the person is still signed in.
  const fail = (e: unknown, fallback: Step | undefined) => {
    if (e instanceof HttpError && e.status === 401) return signedOut(401);
    if (fallback) setStep(fallback);
    else setError('Something went wrong. Try again');
  };
  const inspect = async (userCode: string) => {
    setError('');
    setStep({ kind: 'checking' });
    try {
      const d = await json<Device>(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
      if (d.status !== 'pending' || !d.boatName || !d.requestedPermissions) return setStep({ kind: 'unusable' });
      setChoice(choices(d.requestedPermissions)[0]!);
      setStep({ kind: 'review', device: { ...d, boatName: d.boatName, requestedPermissions: d.requestedPermissions } });
    } catch (e) {
      fail(e, e instanceof HttpError && e.status < 500 ? { kind: 'unusable' } : { kind: 'enter' });
    }
  };
  useEffect(() => {
    if (initial) void inspect(initial);
  }, []);

  const title = step.kind === 'review' ? `Approve ${step.device.boatName}?` : COPY[step.kind].title;
  useLayoutEffect(() => {
    document.title = `${title} · lobstah spyglass`;
    if (step.kind !== 'checking') heading.current?.focus({ preventScroll: true });
  }, [step.kind]);

  const decide = async (approve: boolean) => {
    if (step.kind !== 'review' || busy) return;
    const d = step.device;
    setBusy(true);
    setError('');
    try {
      if (approve)
        await json('/api/auth/wharf/approve', { userCode: code.trim(), name: d.boatName, requestedPermissions: d.requestedPermissions, permissions: ACCESS[choice]!.permissions });
      else await json('/api/auth/device/deny', { userCode: code.trim() });
      setStep({ kind: approve ? 'approved' : 'denied', name: d.boatName });
    } catch (e) {
      fail(e, e instanceof HttpError && e.status < 500 ? { kind: 'unusable' } : undefined);
    } finally {
      setBusy(false);
    }
  };

  const detail = step.kind === 'review' ? undefined : COPY[step.kind].detail;
  let body: unknown = null;
  if (step.kind === 'enter')
    body = html`<form class="auth-consent-form" onSubmit=${(e: Event) => {
      e.preventDefault();
      if (code.trim()) void inspect(code.trim());
    }}><label for="auth-consent-code">Code</label><input id="auth-consent-code" autocomplete="off" autocapitalize="characters" spellcheck=${false} maxLength="128" value=${code} onInput=${(e: Event) => setCode(value(e))} /><button class="auth-github auth-consent-primary" disabled=${!code.trim()}>Continue</button></form>`;
  else if (step.kind === 'review') {
    const d = step.device,
      options = choices(d.requestedPermissions),
      { can, cannot } = abilities(choice);
    body = html`${d.previousBoatName && d.previousBoatName !== d.boatName && html`<p class="auth-detail">Previously named ${d.previousBoatName}</p>`}<p class="auth-consent-code">Check that your terminal shows <b>${code.trim()}</b></p>${
      options.length > 1
        ? html`<label class="auth-consent-access">Access <select aria-label="Access" value=${choice} onChange=${(e: Event) => setChoice(value(e))}>${options.map((o) => html`<option value=${o}>${ACCESS[o]!.label}</option>`)}</select></label>`
        : html`<p class="auth-consent-access">Access: <b>${ACCESS[choice]!.label}</b></p>`
    }<div class="auth-consent-lists"><div><h3>It can</h3><ul>${can.map((t) => html`<li>${t}</li>`)}</ul></div>${cannot.length > 0 && html`<div><h3>It can't</h3><ul>${cannot.map((t) => html`<li>${t}</li>`)}</ul></div>`}</div><div class="auth-consent-actions"><button class="auth-github auth-consent-primary" disabled=${busy} onClick=${() => void decide(true)}>Approve</button><button class="auth-consent-secondary" disabled=${busy} onClick=${() => void decide(false)}>Deny</button></div>`;
  } else if (step.kind === 'approved' || step.kind === 'denied' || step.kind === 'unusable') body = html`<a class="auth-consent-link" href="/">Open the glass</a>`;

  return html`<div class="auth-shell"><header class="auth-brand"><img src=${logo} width="64" height="64" alt="Lobstah lobster and star" /><b>lobstah spyglass</b></header><main class="auth-main auth-consent-main"><section class="auth-card auth-consent-card" aria-labelledby="auth-title" aria-busy=${step.kind === 'checking'}><div class="auth-card-body"><h2 id="auth-title" ref=${heading} tabindex="-1" role=${step.kind === 'checking' ? 'status' : undefined}>${title}</h2>${detail && html`<p id="auth-detail" class="auth-detail">${detail}</p>`}${error && html`<p class="bad" role="alert">${error}</p>`}${body}</div></section></main><footer class="auth-footer">Nobody stares at the water</footer></div>`;
}
