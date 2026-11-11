import { GLASS_CSS, GLASS_SCRIPT } from './glass-page.generated.js';
import { GLASS_INSTALL_HEAD } from './glass-install.js';

/**
 * What the server knew of the visitor's session when it served the page:
 * signed in, signed out, or not invited. The page shows the sign-in screen or
 * the glass from it, never the sign-in screen first. Absent when the check
 * could not answer; the page then asks before it shows anything.
 */
export type SessionHint = 'in' | 'out' | 'denied';

/** The same nonce-protected shell for the glass and its auth UI. */
export function glassPage(session?: SessionHint): Response {
  const nonce = crypto.randomUUID();
  const hint = session ? `<meta name="lobstah-session" content="${session}">` : '';
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>lobstah spyglass</title>${hint}${GLASS_INSTALL_HEAD}<style nonce="${nonce}">${GLASS_CSS}</style></head><body><script nonce="${nonce}">${GLASS_SCRIPT}</script></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` },
  });
}
