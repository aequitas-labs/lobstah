import { useLayoutEffect, useRef } from 'preact/hooks';
import { html } from './common.js';

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

const COPY: Record<AuthState, { eyebrow: string; title: string; detail: string }> = {
  signin: { eyebrow: 'YOUR GROUNDS AWAIT', title: 'Welcome aboard.', detail: 'Sign in to bring your fleet into view.' },
  'signed-out': {
    eyebrow: 'SIGNED OUT',
    title: 'See you soon.',
    detail: 'You’re signed out of the glass. Come back whenever you’re ready.',
  },
  denied: {
    eyebrow: 'INVITATION NEEDED',
    title: 'Let’s get you on the list.',
    detail:
      'This GitHub account isn’t invited to this wharf yet. Ask the wharf operator to add your GitHub account, then continue with the invited account.',
  },
  error: {
    eyebrow: 'A HITCH AT THE DOCK',
    title: 'We couldn’t sign you in.',
    detail: 'Something interrupted the connection. Try again in a moment. If it keeps happening, ask the wharf operator for a hand.',
  },
  expired: {
    eyebrow: 'A FRESH START',
    title: 'Let’s reconnect.',
    detail: 'Your session or sign-in link has expired. Continue with GitHub to pick up where you left off.',
  },
  cancelled: {
    eyebrow: 'SIGN-IN CANCELLED',
    title: 'No rush. We’re here.',
    detail: 'GitHub sign-in wasn’t completed. You can try again whenever you’re ready.',
  },
  connecting: {
    eyebrow: 'HEADING TO GITHUB',
    title: 'One moment…',
    detail: 'Opening GitHub so you can securely continue to your grounds.',
  },
  checking: { eyebrow: 'COMING ABOARD', title: 'Finding your grounds…', detail: 'Checking your session and bringing the glass into view.' },
};

/** Official, unmodified Primer Octicons mark-github-16, white on black.
 * Copyright (c) 2026 GitHub Inc. (MIT).
 * https://github.com/primer/octicons/blob/main/LICENSE
 * https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg
 * https://brand.github.com/foundations/logo
 */
const GitHubMark = () =>
  html`<svg class="github-mark" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" /></svg>`;

export function AuthScreen({ state, authenticate, notice }: { state: AuthState; authenticate: () => void; notice?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(state);
  useLayoutEffect(() => {
    document.title = `${COPY[state].title} · lobstah spyglass`;
    if (previous.current !== state && state !== 'connecting') heading.current?.focus({ preventScroll: true });
    previous.current = state;
  }, [state]);
  const copy = COPY[state];
  const waiting = state === 'connecting' || state === 'checking';
  return html`<div class="auth-shell"><header class="auth-brand"><img src="/icons/icon-192.png" width="64" height="64" alt="Lobstah lobster and star" /><div><b>lobstah</b><span>spyglass / wharf</span></div></header><main class="auth-main"><section class="auth-intro" aria-labelledby="auth-intro-title"><p class="auth-eyebrow">A WINDOW ON YOUR WORK</p><h1 id="auth-intro-title">Your fleet.<br /><span>In sight.</span></h1><p class="auth-lede">The work moves.<br /> You stay in the loop.</p><ul class="auth-features"><li><span aria-hidden="true">01</span> Make the next decision.</li><li><span aria-hidden="true">02</span> Follow every dispatch.</li><li><span aria-hidden="true">03</span> See what comes home.</li></ul></section><section class=${'auth-card auth-' + state} aria-labelledby="auth-title" aria-busy=${waiting}><div class="auth-card-top"><span class="auth-dot" aria-hidden="true"></span><span>THE WHARF</span><span class="auth-private">invite-only</span></div><div class="auth-card-body"><p class="auth-eyebrow">${copy.eyebrow}</p><h2 id="auth-title" ref=${heading} tabindex="-1" aria-describedby="auth-detail">${copy.title}</h2><p id="auth-detail" class="auth-detail" role=${waiting ? 'status' : undefined}>${copy.detail}</p>${notice && html`<p class="auth-notice" role="status">${notice}</p>`}<button class="auth-github" type="button" disabled=${waiting} onClick=${authenticate}><${GitHubMark} /><span>${state === 'connecting' ? 'Connecting to GitHub…' : state === 'checking' ? 'Checking your session…' : 'Continue with GitHub'}</span>${!waiting && html`<span aria-hidden="true">↗</span>`}</button><div class="auth-access"><b>Your GitHub account. Your grounds.</b><p>Invited GitHub accounts can access their own grounds and the repositories connected by their boats.</p><p>GitHub confirms your identity. Signing in doesn’t add repository access or take a helm seat.</p></div></div></section></main><footer class="auth-footer"><span>Your boats do the work. The glass keeps watch.</span><span>lobstah / spyglass</span></footer></div>`;
}
