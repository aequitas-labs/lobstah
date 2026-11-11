import type { Children } from './html.js';

/**
 * What a host adds around the shared glass. The local glass adds nothing;
 * the hosted glass adds its sign-out and "helm live" chip, its account page
 * (Boats), the human requests waiting for the helm, its notices and the boat
 * approval form, and its footer line. Each part renders inside the glass on
 * every paint, so it reads the host's latest state.
 */
export interface GlassHost {
  /** After the header's chips: the hosted glass's helm chip and sign-out. */
  chips?: () => Children;
  /** Above every tab: notices and, on /device, the boat approval form. */
  banner?: () => Children;
  /** After the deck's own sections. */
  deck?: () => Children;
  /** The Boats tab's page, for a source whose capabilities list `boats`. */
  boats?: () => Children;
  /** The footer's line, for a source with no version of its own. */
  footer?: string;
}

let current: GlassHost = {};

/** Set by startGlassPage. */
export function setHost(host: GlassHost): void {
  current = host;
}

/** The page's host parts; none for the local glass. */
export const host = (): GlassHost => current;
