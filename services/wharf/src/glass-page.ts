import { GLASS_CSS, GLASS_SCRIPT } from './glass-page.generated.js';
import { GLASS_INSTALL_HEAD } from './glass-install.js';

/**
 * What the server knew of the visitor's session when it served the page:
 * signed in, signed out, or not invited. The page shows the sign-in screen or
 * the glass from it, never the sign-in screen first. Absent when the check
 * could not answer; the page then asks before it shows anything.
 */
export type SessionHint = 'in' | 'out' | 'denied';

/**
 * The remote hosts the hosted glass loads images from, all GitHub's. Every
 * other image comes from the wharf itself: a boat's attachments through the
 * mirror relay, and wharf files from R2.
 *
 * - `avatars.githubusercontent.com`: people's avatars on review and PR cards.
 * - `raw.githubusercontent.com`: PR evidence screenshots on the `pr-evidence`
 *   branch (`scripts/pr-assets.sh`). Decision cards link them in Markdown, and
 *   GitHub's rendered PR description keeps the same URLs.
 * - `github.com`, `user-images.githubusercontent.com`,
 *   `private-user-images.githubusercontent.com` and `camo.githubusercontent.com`:
 *   the other image URLs in GitHub's rendered PR descriptions.
 *
 * A card's image from any other host is refused, and the card shows it as a link.
 */
export const GLASS_IMAGE_HOSTS: readonly string[] = [
  'https://avatars.githubusercontent.com',
  'https://raw.githubusercontent.com',
  'https://user-images.githubusercontent.com',
  'https://github.com',
  'https://private-user-images.githubusercontent.com',
  'https://camo.githubusercontent.com',
];

/**
 * The same nonce-protected shell for the glass and its auth UI. Besides the
 * wharf, the page connects only to a boat's glass on loopback, for the mirror
 * probe and ↗ Open (glass-ui backends/mirror.ts); its port is the boat's.
 * Images load from the wharf and from GLASS_IMAGE_HOSTS only.
 */
export function glassPage(session?: SessionHint): Response {
  const nonce = crypto.randomUUID();
  const hint = session ? `<meta name="lobstah-session" content="${session}">` : '';
  const imageSources = ["'self'", 'blob:', 'data:', ...GLASS_IMAGE_HOSTS].join(' ');
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>lobstah spyglass</title>${hint}${GLASS_INSTALL_HEAD}<style nonce="${nonce}">${GLASS_CSS}</style></head><body><script nonce="${nonce}">${GLASS_SCRIPT}</script></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src ${imageSources}; connect-src 'self' http://127.0.0.1:*; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` },
  });
}
