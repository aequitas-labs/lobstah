import { render } from 'preact';
import { setDecisionBadge } from '../../../../packages/glass-ui/ui/app-badge.js';
import { createWharfBackend } from '../../../../packages/glass-ui/ui/backends/wharf.js';
import type { WharfBackend } from '../../../../packages/glass-ui/ui/backends/wharf.js';
import { createMirrorBackend } from '../../../../packages/glass-ui/ui/backends/mirror.js';
import type { MirrorBackend } from '../../../../packages/glass-ui/ui/backends/mirror.js';
import { Age } from '../../../../packages/glass-ui/ui/components/common.js';
import { LinkedText } from '../../../../packages/glass-ui/ui/components/links.js';
import { startGlassPage } from '../../../../packages/glass-ui/ui/start.js';
import type { GlassPage } from '../../../../packages/glass-ui/ui/start.js';
import { HttpError, json } from './api.js';
import { AuthScreen, authDestination, authEntry } from './auth-screen.js';
import type { AuthState } from './auth-screen.js';
import { Boats } from './boats.js';
import { CardDetail } from '../../../../packages/glass-ui/ui/components/canonical-card.js';
import { html } from './common.js';
import { DeviceConsent } from './device.js';
import { PasskeyPairing } from './pairing.js';
import { requestState } from './model.js';
import { glassSocket } from './socket.js';
import { Button } from '../../../../packages/glass-ui/ui/components/button.js';

/**
 * The hosted glass: GitHub sign-in around the shared glass, which runs on the
 * wharf backend with the local glass's own components. This file holds only
 * what is the host's: the sign-in screen, sign-out, the wake hint, the boats
 * page, the human requests waiting for the helm, and the links boats hand out (`#job/<id>`, `#trap/<id>`) mapped onto the
 * shared glass's routes. An account with mirror boats runs on the mirror
 * backend: each boat's own glass, merged, with the wharf's own grounds beside
 * them. Boat approval on /device is its own consent page (device.ts).
 */

/** The backend a session runs on: the wharf's, or its mirror boats' with the wharf's beside them. */
type HostedBackend = WharfBackend | MirrorBackend;

/** A live session's parts, all stopped together on sign-out or expiry. */
interface Session {
  page: GlassPage;
  backend: HostedBackend;
  stop(): void;
}

let session: Session | undefined;
let hadSession = false;
let notice: { text: string; bad: boolean } | undefined;

/** The old hosted views and item links, as the shared glass names them; the item opens once it is listed. */
function translateLink(): { kind: 'dispatch' | 'trap'; id: string } | undefined {
  const hash = location.hash;
  const item = /^#(job|trap)\/([A-Za-z0-9_-]{1,128})$/.exec(hash);
  const view = { '#jobs': '#dispatches', '#job': '#dispatches', '#trap': '#traps', '#review': '#reviews' }[item ? '#' + item[1] : hash];
  if (/^#review\/[A-Za-z0-9_-]{1,128}$/.test(hash)) history.replaceState(null, '', '#reviews');
  else if (view) history.replaceState(null, '', view);
  return item ? { kind: item[1] === 'job' ? 'dispatch' : 'trap', id: item[2]! } : undefined;
}

function showAuth(state: AuthState): void {
  // Signing in on the way to approve a boat shows the sign-in card alone.
  const device = authDestination(location).pathname === '/device';
  render(html`<${AuthScreen} state=${state} authenticate=${authenticate} device=${device} />`, document.body);
}

let authBusy = false;
async function authenticate(): Promise<void> {
  if (authBusy) return;
  authBusy = true;
  showAuth('connecting');
  try {
    const destination = authDestination(location);
    const failure = new URL('/api/auth/error', location.origin);
    failure.searchParams.set('returnTo', destination.pathname + destination.search + destination.hash);
    const result = await json<{ url: string }>('/api/auth/sign-in/social', {
      provider: 'github',
      callbackURL: destination.href,
      errorCallbackURL: failure.href,
    });
    location.assign(result.url);
  } catch (e) {
    showAuth(e instanceof HttpError && e.status === 403 ? 'denied' : 'error');
    authBusy = false;
  }
}

/** Stop everything a session runs, then show the sign-in screen in its place. */
function end(state: AuthState): void {
  session?.stop();
  session = undefined;
  void setDecisionBadge(0);
  showAuth(state);
}

function notify(text: string, bad = false): void {
  notice = { text, bad };
  session?.page.repaint();
}

/** A write from the host's own pages (boats, trap requests): same-origin JSON with an idempotency key. */
async function action(path: string, body: unknown): Promise<boolean> {
  try {
    await json('/api/glass/' + path, body);
    notify(path === 'requests' ? 'Queued for the helm; it expires in 10 minutes.' : path.endsWith('/revoke') ? 'Boat revoked.' : 'Saved.');
    await session?.page.refresh();
    return true;
  } catch (e) {
    notify((e as Error).message, true);
    return false;
  }
}

async function signOut(): Promise<void> {
  const live = session;
  live?.stop();
  session = undefined;
  try {
    await json('/api/auth/sign-out', {});
    void setDecisionBadge(0);
    showAuth('signed-out');
  } catch (e) {
    notify((e as Error).message, true);
    if (live) start();
  }
}

async function deleteAccount(): Promise<void> {
  try {
    await json('/api/glass/account', { confirm: true }, 'DELETE');
    end('signed-out');
  } catch (e) {
    notify((e as Error).message, true);
  }
}

/** The human requests waiting for the helm: what the person queued from this glass. */
function HumanRequests({ backend }: { backend: HostedBackend }) {
  const requests = backend.account()?.requests ?? [];
  if (!requests.length) return null;
  return html`<div class="sec">Your requests</div>${requests.map(
    (r) =>
      html`<div class="msg" key=${r.id}><b>${r.kind}</b> · ${r.dispatch ?? r.boat ?? r.document ?? 'new work'} · ${requestState(r)}<div>${LinkedText(r.text ?? r.repo ?? r.document)}</div></div>`,
  )}`;
}

/** Each mirror boat in the header, with how old its snapshot is: an asleep boat's rows are read-only. */
function MirrorChips({ backend }: { backend: MirrorBackend }) {
  return backend.boats().map(
    (b) => html`<span key=${b.boat} class=${b.stale ? 'chip warn' : 'chip dim'} title=${b.stale ? 'asleep: its rows are read-only' : 'mirrored from this boat'}>${b.name} · mirrored ${Age(b.at)} ago${b.stale ? ' · asleep' : ''}</span>`,
  );
}

/** A canonical card link stays inside the signed-in glass after the shared UI migration. */
function HostedCard({ backend }: { backend: HostedBackend }): ReturnType<typeof html> | null {
  const match = /^#card\/(c\d{1,15})$/.exec(location.hash);
  if (!match) return null;
  return html`<section class="card"><${Button} onClick=${() => { location.hash = '#deck'; }}>Close card<//><${CardDetail}
    id=${match[1]}
    load=${(id: string) => json<import('../../../../packages/core/src/backend-model.js').GlassCard>(`/api/glass/cards/${encodeURIComponent(id)}`)}
    open=${(item: import('../../../../packages/core/src/backend-model.js').GlassCardItem) => { location.hash = `#${item.kind}/${item.id}`; }}
    boatName=${(id: string) => backend.account()?.boats.find((boat) => boat.id === id)?.name}
  /></section>`;
}

function start(mirror = false): void {
  const signedOut = (status: 401 | 403) => end(status === 403 ? 'denied' : hadSession ? 'expired' : 'signin');
  let page: GlassPage | undefined;
  let mirrorBackend: MirrorBackend | undefined;
  // The page's live channel: pushed events read the page again, a boat's pushed snapshot shows with no request.
  const socket = glassSocket({
    live: (open) => page?.live(open),
    refresh: () => void page?.refresh(),
    snapshot: (pushed) => {
      if (mirrorBackend) page?.apply(mirrorBackend.applySnapshot(pushed));
    },
  });
  const wharf = createWharfBackend({ onSignedOut: signedOut });
  const backend: HostedBackend = mirror ? (mirrorBackend = createMirrorBackend({ wharf, onSignedOut: signedOut, socket })) : wharf;
  const pending = translateLink();
  // Registered before the glass's own route listener, so the glass reads the translated hash.
  const follow = () => {
    const item = translateLink();
    if (item) page?.open(item);
  };
  window.addEventListener('hashchange', follow);
  page = startGlassPage(backend, {
    chips: () => [
      'boats' in backend ? html`<${MirrorChips} backend=${backend} />` : html`<span class="chip">${backend.account()?.helmLive ? 'helm live' : 'no helm signed on'}</span>`,
      html`<${Button} onClick=${() => void signOut()}>Sign out<//>`,
    ],
    banner: () => [
      notice && html`<div class=${notice.bad ? 'bad' : 'ok'} role=${notice.bad ? 'alert' : 'status'}>${notice.text}</div>`,
      html`<${HostedCard} backend=${backend} />`,
    ],
    deck: () => html`<${HumanRequests} backend=${backend} />`,
    boats: () => html`<${Boats} boats=${backend.account()?.boats ?? []} mirrors=${mirror ? (backend as MirrorBackend).boats() : []} action=${action} deleteAccount=${deleteAccount} />`,
    footer: 'wharf · PR watches and repair run on your boats',
    fleet: () =>
      'boats' in backend ? html`<${MirrorChips} backend=${backend} />` : html`<span class="chip">helm ${backend.account()?.helmLive ? 'live' : 'unknown / no live lease'}</span>`,
    signOut: () => void signOut(),
    asleep: () => mirror && (backend as MirrorBackend).boats().some((b) => b.stale),
  });
  if (pending) page.open(pending);
  const live = page;
  socket.connect();
  // A dropped socket reconnects every 15 s; the page polls meanwhile, so nothing is lost.
  const reconnect = setInterval(() => socket.connect(), 15000);
  hadSession = true;
  document.title = 'lobstah spyglass';
  session = {
    page: live,
    backend,
    stop() {
      live.stop();
      socket.close();
      clearInterval(reconnect);
      window.removeEventListener('hashchange', follow);
    },
  };
}

/** The session the server saw when it served this page (glass-page.ts), if it could tell. */
function sessionHint(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="lobstah-session"]')?.content;
}

/** Boat approval: its own page, for a signed-in person. */
/** Pairing a phone's passkey with a boat: its own page, like boat approval. */
function showPairing(): void {
  hadSession = true;
  render(html`<${PasskeyPairing} signedOut=${(status: 401 | 403) => end(status === 403 ? 'denied' : 'expired')} />`, document.body);
}

function showDevice(): void {
  hadSession = true;
  render(html`<${DeviceConsent} signedOut=${(status: 401 | 403) => end(status === 403 ? 'denied' : 'expired')} />`, document.body);
}

/**
 * A returning auth error shows its screen. Otherwise the server's session
 * hint decides: signed out goes straight to sign-in; signed in (or unknown)
 * shows nothing until the session answers, then the glass or boat approval.
 * The sign-in screen never flashes before the glass.
 */
async function boot(): Promise<void> {
  const entry = authEntry(location);
  if (entry) return showAuth(entry);
  const hint = sessionHint();
  if (hint === 'out') return showAuth('signin');
  if (hint === 'denied') return showAuth('denied');
  try {
    await json('/api/glass');
    if (location.pathname === '/device') return showDevice();
    if (location.pathname === '/passkey') return showPairing();
    // Mirror boats show their own glass here; without any, the wharf's grounds show as they always have.
    // A wharf without mirror routes, or any odd answer, means no mirror boats.
    const mirrored = await json<{ boats?: unknown }>('/api/glass/mirror').catch(() => undefined);
    start(Array.isArray(mirrored?.boats) && mirrored.boats.length > 0);
  } catch (e) {
    showAuth(e instanceof HttpError ? (e.status === 403 ? 'denied' : e.status === 401 ? 'signin' : 'error') : 'error');
  }
}

void boot();
