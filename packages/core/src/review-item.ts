/**
 * A review request as plain data, whatever its source; today a GitHub PR
 * that asked for your review. The glass renders every
 * one with the same item card (glass-ui item-card.ts), drawing the source's
 * logo, the item's glyph and its chips from these fields. A source fills the
 * fields; it never sends markup, classes or colors. This module has no Node
 * dependencies, so the glass shares its types.
 */

/** Glyphs the glass draws. A source names one; the glass owns its artwork and color. */
export const REVIEW_ITEM_GLYPHS = ['github', 'source', 'pull-request', 'document'] as const;
export type ReviewRequestItemGlyph = (typeof REVIEW_ITEM_GLYPHS)[number];

/**
 * A source's logo: a glyph the glass draws, or an HTTPS image with the glyph
 * to show when the image is missing or fails to load.
 */
export type ReviewSourceIcon = { glyph: ReviewRequestItemGlyph } | { image: string; fallback: ReviewRequestItemGlyph };

/** Who an item comes from. `name` is the logo's accessible name and tooltip; `id` groups items. */
export interface ReviewSource {
  id: string;
  name: string;
  icon: ReviewSourceIcon;
}

/** The subject's lifecycle phase, which picks its glyph's and chip's color. */
export const REVIEW_LIFECYCLE_PHASES = ['active', 'draft', 'completed', 'closed'] as const;
export type ReviewLifecyclePhase = (typeof REVIEW_LIFECYCLE_PHASES)[number];

/**
 * Where the subject is: its phase, the source's word for it ("Open",
 * "Merged", "In review"), and whether it is archived. Archived keeps the
 * phase and its color, and adds an archived chip.
 */
export interface ReviewLifecycle {
  phase: ReviewLifecyclePhase;
  label: string;
  archived?: boolean;
}

/**
 * The glyph that leads the item's title, for its kind. A phase may name a
 * different glyph; otherwise the kind glyph shows, colored by the phase.
 */
export interface ReviewKindGlyph {
  kind: ReviewRequestItemGlyph;
  variants?: Partial<Record<ReviewLifecyclePhase, ReviewRequestItemGlyph>>;
}

/** What a status means. The glass picks its color from this alone. */
export const REVIEW_STATUS_MEANINGS = ['neutral', 'pending', 'working', 'ready', 'done', 'caution', 'needs-you', 'failed'] as const;
export type ReviewStatusMeaning = (typeof REVIEW_STATUS_MEANINGS)[number];

/** One status chip after the lifecycle chip. */
export interface ReviewRequestItemStatus {
  label: string;
  meaning: ReviewStatusMeaning;
  /** Hover text that says more than the label. */
  detail?: string;
  /** The item changed since you last opened it: this chip carries the unread dot. */
  unread?: boolean;
}

/**
 * What the item asks of you, shown as the card's edge: red when it needs
 * you or failed, amber while work is under way, green when it is ready,
 * dim when nothing is asked. A completed, closed or archived item has no edge.
 */
export const REVIEW_ATTENTION_STATES = ['none', 'working', 'ready', 'needs-you', 'error'] as const;
export type ReviewAttention = (typeof REVIEW_ATTENTION_STATES)[number];

/** The person an item is about (who asked for the review), shown as the card's avatar chip. */
export interface ReviewRequester {
  /** Their login or id. */
  id: string;
  name?: string;
  /** An HTTPS avatar; without one the chip shows initials. */
  avatarUrl?: string;
  /** What they are to the item, for the hover text: "requested by". */
  role: string;
}

/**
 * One value on the card's context line. The glass formats each kind:
 * `project` with the repo mark, `time` as an age, `owner` as a trap address.
 */
export const REVIEW_CONTEXT_KINDS = ['project', 'reference', 'revision', 'time', 'owner', 'text'] as const;
export type ReviewContextKind = (typeof REVIEW_CONTEXT_KINDS)[number];
export interface ReviewContext {
  kind: ReviewContextKind;
  /** An ISO time for `time`; a trap address for `owner`; otherwise the text shown. */
  value: string;
}

/**
 * A human action on the item, as a link: the glass opens it in a new tab.
 * `primary` shows as a labelled button in the card's bar; `open` as the
 * Open icon at the bar's far right.
 */
export interface ReviewLink {
  label: string;
  href: string;
  placement: 'primary' | 'open';
}

/** One review request, from any source. */
export interface ReviewRequestItem {
  /** Stable across revisions, unique within its source. */
  id: string;
  source: ReviewSource;
  title: string;
  /** The source's word for what this is: "pull request", "plan". */
  kind: string;
  glyph: ReviewKindGlyph;
  lifecycle: ReviewLifecycle;
  /** Status chips after the lifecycle chip, in order. */
  statuses: ReviewRequestItemStatus[];
  attention: ReviewAttention;
  person?: ReviewRequester;
  /** The context line after the source logo, in order. */
  context: ReviewContext[];
  /** When the review was requested. */
  requestedAt?: string;
  /** Where a tap on the card goes. */
  target?: string;
  actions: ReviewLink[];
  /** The request is no longer open: the card shows quiet. */
  resolved?: boolean;
}

/** GitHub review requests carry the GitHub brand. */
export const GITHUB_REVIEW_SOURCE: ReviewSource = { id: 'github', name: 'GitHub', icon: { glyph: 'github' } };

/** The glyph for a phase: the source's variant for it, else the kind glyph. */
export function reviewGlyphFor(glyph: ReviewKindGlyph, phase: ReviewLifecyclePhase): ReviewRequestItemGlyph {
  return glyph.variants?.[phase] ?? glyph.kind;
}

/** Schemes a link never follows: they run code or read local files. */
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

/**
 * A link or image the glass follows: an absolute URL with no credentials.
 * A link may open an app (a review tool's `linear://`); an image loads over HTTPS only.
 */
export function safeReviewUrl(url: string, image = false): boolean {
  try {
    const parsed = new URL(url);
    const ok = image ? parsed.protocol === 'https:' : !REFUSED_SCHEMES.has(parsed.protocol);
    return ok && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** The card edge's tone, or none for a finished item. */
export function reviewAttentionEdge(item: Pick<ReviewRequestItem, 'attention' | 'lifecycle'>): 'ok' | 'warn' | 'bad' | 'dim' | undefined {
  if (item.lifecycle.archived || item.lifecycle.phase === 'completed' || item.lifecycle.phase === 'closed') return undefined;
  return ({ none: 'dim', working: 'warn', ready: 'ok', 'needs-you': 'bad', error: 'bad' } as const)[item.attention];
}

/** A status's tone, from its meaning. */
export const REVIEW_STATUS_TONE: Readonly<Record<ReviewStatusMeaning, 'ok' | 'warn' | 'bad' | 'dim'>> = {
  neutral: 'dim',
  pending: 'warn',
  working: 'warn',
  ready: 'ok',
  done: 'ok',
  caution: 'warn',
  'needs-you': 'bad',
  failed: 'bad',
};

/** The lifecycle color reuses the PR tokens: active green, draft grey, completed purple, closed red. */
export const REVIEW_LIFECYCLE_TOKEN: Readonly<Record<ReviewLifecyclePhase, 'pr-open' | 'pr-draft' | 'pr-merged' | 'pr-closed'>> = {
  active: 'pr-open',
  draft: 'pr-draft',
  completed: 'pr-merged',
  closed: 'pr-closed',
};

