import type { ViewerDevice } from '@lobstah/core';

const PHONE_RE = /iPhone|iPad|iPod|Android|Mobile|Windows Phone/i;
const DESKTOP_RE = /Macintosh|Windows NT|X11|CrOS|Linux/;

/**
 * The kind of device behind a request, from its User-Agent and the
 * Sec-CH-UA-Mobile client hint, which only Chromium sends and only to a secure
 * page. Phones and tablets both read as `phone`. This decides what a page
 * offers and authorizes nothing. iPadOS Safari and "request desktop site" call
 * themselves desktops, and nothing in the request says otherwise.
 */
export function viewerDevice(userAgent = '', mobileHint?: unknown): ViewerDevice {
  if (mobileHint === '?1' || PHONE_RE.test(userAgent)) return 'phone';
  return DESKTOP_RE.test(userAgent) ? 'desktop' : 'unknown';
}
