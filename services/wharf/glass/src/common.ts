import { html } from '../../../../packages/glass-ui/ui/html.js';

/** The hosted glass's own pages (sign-in, boats, boat approval) share the glass UI's htm. */
export { html };
/** An input's value, from its event. */
export const value = (e: Event) => (e.currentTarget as HTMLInputElement).value;
/** A time as the person's locale reads it; unknown when the wharf has none. */
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'unknown');
/** A write from a host page: true once the wharf took it. */
export type Action = (path: string, body: unknown) => Promise<boolean>;
