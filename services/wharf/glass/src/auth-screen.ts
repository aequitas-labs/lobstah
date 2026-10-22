import { useLayoutEffect, useRef } from 'preact/hooks';
import { html } from './common.js';
import logo from '../../../../docs/assets/favicon.png';
import buoy from '../../../../apps/site/assets/buoy-flag-160.webp';
import buoyBody from '../../../../apps/site/assets/buoy-body-160.webp';
import trap from '../../../../apps/site/assets/trap-180.webp';
import crawl from '../../../../docs/assets/lob-crawl.svg';

export type AuthState = 'signin' | 'signed-out' | 'denied' | 'error' | 'expired' | 'cancelled' | 'connecting' | 'checking';

/** Provider messages are untrusted; display only our own, actionable copy. */
export function authEntry(location: Pick<Location, 'pathname' | 'search'>): AuthState | null {
  if (location.pathname === '/api/auth/sign-in/social') return 'signin';
  if (location.pathname !== '/api/auth/error') return null;
  const code = new URLSearchParams(location.search).get('error') ?? '';
  if (code === 'invite_required') return 'denied';
  if (code === 'access_denied') return 'cancelled';
  if (/^(state_not_found|state_mismatch|state_expired|invalid_state|invalid_callback_request)$/.test(code)) return 'expired';
  return 'error';
}

/** Retry returns only to a glass page, preserving deep links and boat approval codes. */
export function authDestination(location: Pick<Location, 'href' | 'origin' | 'pathname' | 'search'>): URL {
  if (!location.pathname.startsWith('/api/auth/')) return new URL(location.href);
  const candidate = new URLSearchParams(location.search).get('returnTo') ?? '/';
  try {
    const target = new URL(candidate, location.origin);
    if (target.origin === location.origin && ['/', '/device'].includes(target.pathname)) return target;
  } catch {
    /* A malformed retry target returns to the glass. */
  }
  return new URL('/', location.origin);
}

const COPY: Record<AuthState, { title: string; detail?: string }> = {
  signin: { title: 'Welcome aboard' },
  'signed-out': { title: 'Ashore for now', detail: "Sign in again whenever you're ready" },
  denied: { title: 'Not on the crew list', detail: "This GitHub account isn't invited to this wharf. Ask its owner to add you" },
  error: { title: "Sign-in didn't finish", detail: 'Something went wrong on the way back from GitHub. Try again in a moment' },
  expired: { title: 'Your session timed out', detail: 'Sign in again to pick up where you left off' },
  cancelled: { title: 'Sign-in cancelled', detail: "Continue with GitHub when you're ready" },
  connecting: { title: 'Opening GitHub…' },
  checking: { title: 'Checking your session…' },
};

// Reuse the banner's original pixels and frame animation in a compact icon viewport.
// Only its travel across the 1200px banner is removed; the art is unchanged.
const crawlIcon = crawl
  .replace('width="1200"', 'width="80"')
  .replace('viewBox="0 0 1200 80"', 'viewBox="0 0 80 80"')
  .replace(/<animateTransform[^>]*\/>/, '');

function CrawlingLobster() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const svg = ref.current?.querySelector('svg');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      if (motion.matches) {
        svg?.pauseAnimations?.();
        svg?.setCurrentTime?.(0);
      } else svg?.unpauseAnimations?.();
    };
    sync();
    motion.addEventListener('change', sync);
    return () => motion.removeEventListener('change', sync);
  }, []);
  return html`<span class="auth-crawl" ref=${ref} aria-hidden="true" dangerouslySetInnerHTML=${{ __html: crawlIcon }} />`;
}

/** Official, unmodified Primer Octicons mark-github-16, white on black.
 * Copyright (c) 2026 GitHub Inc. (MIT).
 * https://github.com/primer/octicons/blob/main/LICENSE
 * https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg
 * https://brand.github.com/foundations/logo
 */
const GitHubMark = () =>
  html`<svg class="github-mark" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" /></svg>`;

export function AuthScreen({ state, authenticate }: { state: AuthState; authenticate: () => void; notice?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(state);
  useLayoutEffect(() => {
    document.title = `${COPY[state].title} · lobstah spyglass`;
    if (previous.current !== state && state !== 'connecting') heading.current?.focus({ preventScroll: true });
    previous.current = state;
  }, [state]);
  const copy = COPY[state];
  const waiting = state === 'connecting' || state === 'checking';
  return html`<div class="auth-shell"><header class="auth-brand"><img src=${logo} width="64" height="64" alt="Lobstah lobster and star" /><b>lobstah spyglass</b></header><main class="auth-main"><section class="auth-intro" aria-labelledby="auth-intro-title"><h1 id="auth-intro-title">Your fleet<br /><span>in sight</span></h1><ul class="auth-features"><li><span class="auth-buoy" aria-hidden="true"><img src=${buoy} width="64" height="64" alt="" /><img src=${buoyBody} width="64" height="64" alt="" /></span><span>Answer when a buoy flags you</span></li><li><img src=${trap} width="64" height="64" alt="" /><span>Know what's working and what's stuck</span></li><li><${CrawlingLobster} /><span>Haul up the catch: PRs, evidence and reports</span></li></ul></section><section class=${'auth-card auth-' + state} aria-labelledby="auth-title" aria-busy=${waiting}><div class="auth-card-body"><h2 id="auth-title" ref=${heading} tabindex="-1" aria-describedby=${copy.detail ? 'auth-detail' : undefined} role=${waiting ? 'status' : undefined}>${copy.title}</h2>${copy.detail && html`<p id="auth-detail" class="auth-detail">${copy.detail}</p>`}<button class="auth-github" type="button" disabled=${waiting} onClick=${authenticate}><${GitHubMark} /><span>Continue with GitHub</span></button><p class="auth-access">GitHub only confirms who you are. It grants no repository access</p></div></section></main><footer class="auth-footer">Nobody stares at the water</footer></div>`;
}
