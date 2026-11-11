/**
 * The shapes a backend's reads and writes answer in. No imports: the shared
 * pieces the hosted glass bundles (the Markdown checklists) use these too,
 * and that page typechecks without core's compiled declarations.
 */

/** A read: its data when the server answered it, its status either way. */
export type GlassRead<T> = { ok: true; status: number; data: T } | { ok: false; status: number };

/** What a write answers: the server's verdict, and whatever else it sent back. */
export interface GlassVerdict {
  ok?: boolean;
  reason?: string;
}

/** A write's answer: its HTTP outcome and the body the server sent, read whatever the status. */
export interface GlassWrite<T> {
  ok: boolean;
  status: number;
  body: T;
}
