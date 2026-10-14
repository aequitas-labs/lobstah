import { GLASS_ICONS } from './glass-page.generated.js';

/**
 * What a browser needs to install the glass as an app: a manifest and icons.
 * Every icon is the lobster with its star (docs/assets). No service worker:
 * nothing is cached or readable offline, and the page stays `no-store`.
 */
const icon = (file: string, size: number, purpose: 'any' | 'maskable') =>
  ({ src: `/icons/${file}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
export const GLASS_MANIFEST = {
  id: '/', name: 'lobstah spyglass', short_name: 'spyglass',
  description: 'Jobs, decisions and reports of the grounds on this wharf.',
  start_url: '/', scope: '/', display: 'standalone',
  // The page's own background (--bg in glass.css), so an app window opens without a flash.
  background_color: '#0e1116', theme_color: '#0e1116',
  icons: [icon('icon-192.png', 192, 'any'), icon('icon-512.png', 512, 'any'), icon('icon-maskable-512.png', 512, 'maskable')],
};
/** The tags the page's head carries for the manifest, the tab icon and the home-screen icon. */
export const GLASS_INSTALL_HEAD = '<link rel="manifest" href="/manifest.webmanifest">'
  + '<link rel="icon" type="image/png" href="/icons/favicon.png">'
  + '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">'
  + `<meta name="theme-color" content="${GLASS_MANIFEST.theme_color}">`;

/** The manifest or one icon; undefined for every other path. Public: neither carries account data. */
export function glassInstall(pathname: string): Response | undefined {
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600' };
  if (pathname === '/manifest.webmanifest') return new Response(JSON.stringify(GLASS_MANIFEST), { headers: { ...headers, 'Content-Type': 'application/manifest+json' } });
  const file = /^\/icons\/([a-z0-9-]+\.png)$/.exec(pathname)?.[1];
  const encoded = file && Object.hasOwn(GLASS_ICONS, file) ? GLASS_ICONS[file] : undefined;
  if (!encoded) return undefined;
  return new Response(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)), { headers: { ...headers, 'Content-Type': 'image/png' } });
}
