import type { WatchAttentionTarget } from './presentation.js';
import type { WatchValue } from './model.js';

/**
 * Presentation v2: a source describes the items it watches and how a person
 * acts on them as typed slot data. The host owns every renderer (the shared
 * Card and ItemCard), its colors, layout and glyph artwork; a source cannot
 * send HTML, CSS classes, colors or render functions. This module has no
 * Node dependencies, so the glass can share its types and host mappings.
 */

/** The presentation contract a source declares; v1 sources keep the original shape. */
export type WatchPresentationVersion = 1 | 2;
export const WATCH_PRESENTATION_VERSIONS: readonly WatchPresentationVersion[] = [1, 2];

/** Host-drawn glyphs a source may name. The host owns their artwork and semantic colors. */
export const WATCH_GLYPHS = [
  'github',
  'ume',
  'source',
  'pull-request',
  'document',
  'document-check',
  'bell',
  'deployment',
  'watch',
] as const;
export type WatchGlyph = (typeof WATCH_GLYPHS)[number];

/**
 * A source logo: a host glyph, or an installed image with light and dark
 * variants plus the glyph to show when the image is missing or fails.
 * Images resolve only through validated HTTPS URLs; SVG markup, scripts and
 * data URLs are never accepted.
 */
export type WatchIcon = { glyph: WatchGlyph } | { asset: { light: string; dark: string }; fallback: WatchGlyph };

/**
 * Who supplies a watch or item. The ID groups sources; the display name is
 * the logo's accessible name and tooltip, and a source section heading shows
 * it in full. Display names never define identity.
 */
export interface WatchSourceBrand {
  id: string;
  name: string;
  icon: WatchIcon;
}

/** Normalized subject lifecycle. A review workflow or watch health never rewrites it. */
export const WATCH_LIFECYCLE_PHASES = ['active', 'draft', 'completed', 'closed'] as const;
export type WatchLifecyclePhase = (typeof WATCH_LIFECYCLE_PHASES)[number];

/**
 * The subject's lifecycle: its phase picks the host's lifecycle color, its
 * label is the source's word ("Open", "Merged", "Approved", "Done"), and
 * `archived` is a visibility flag that keeps the underlying phase and color.
 */
export interface WatchItemLifecycle {
  phase: WatchLifecyclePhase;
  label: string;
  archived?: boolean;
}

/**
 * The item-kind glyph that leads a card's title. The host selects a variant
 * by lifecycle phase and colors it by that phase; a missing variant uses the
 * kind glyph.
 */
export interface WatchItemGlyph {
  kind: WatchGlyph;
  variants?: Partial<Record<WatchLifecyclePhase, WatchGlyph>>;
}

/** Status chips follow the lifecycle chip: workflow first, then attention, then watch health. */
export const WATCH_STATUS_CATEGORIES = ['workflow', 'attention', 'health'] as const;
export type WatchStatusCategory = (typeof WATCH_STATUS_CATEGORIES)[number];

/** The canonical meaning of a status; the host chooses its token. Colors never depend on the source. */
export const WATCH_STATUS_MEANINGS = ['neutral', 'pending', 'working', 'ready', 'done', 'caution', 'needs-you', 'failed'] as const;
export type WatchStatusMeaning = (typeof WATCH_STATUS_MEANINGS)[number];

/** One status chip: a domain code, its short label, and its canonical category and meaning. */
export interface WatchItemStatus {
  code: string;
  label: string;
  category: WatchStatusCategory;
  meaning: WatchStatusMeaning;
  /** Hover text that says more than the label. */
  detail?: string;
  /** Where the status links (a posted review), using the same validated targets as actions. A linked status reads as a link, not a chip. */
  target?: WatchAttentionTarget;
  /** When the status began; the host shows its age after the label. */
  at?: string;
  /** Short text after the chip: "Waiting on CI". */
  note?: string;
}

/**
 * Canonical attention, shown as the card's edge: red for needs-you or error,
 * amber while work is in progress, green when ready, a dim edge when nothing
 * is asked. A completed, closed or archived item never shows an actionable edge.
 */
export const WATCH_ATTENTION_STATES = ['none', 'working', 'ready', 'needs-you', 'error'] as const;
export type WatchItemAttention = (typeof WATCH_ATTENTION_STATES)[number];

/**
 * The standing notification: the revision a person acknowledges by opening
 * the item, and whether it is unread. Seen is independent of lifecycle: seen
 * does not mean done.
 */
export interface WatchItemNotification {
  revision: string;
  unread: boolean;
  seen?: boolean;
  /** The declared effect that acknowledges this revision when the person opens the item. */
  action?: string;
}

/** The person an item is about (its requester or author), shown as the card's avatar chip. */
export interface WatchItemPerson {
  id: string;
  name?: string;
  /** An avatar image; validated like every other asset, with initials as the fallback. */
  avatarUrl?: string;
  /** What they are to the item, for the hover text: "requested by", "author". */
  role: string;
  /** A short chip beside their name in tables and details ("automatic"), with its hover text. */
  badge?: { label: string; detail?: string };
}

/**
 * Typed metadata for the card's context line. The host formats times as
 * ages, resolves owners to names, and joins values with its separator; a
 * source never invents a value to fill a slot.
 */
export const WATCH_METADATA_KINDS = ['project', 'reference', 'revision', 'owner', 'time', 'text', 'person'] as const;
export type WatchMetadataKind = (typeof WATCH_METADATA_KINDS)[number];
export interface WatchItemMetadata {
  kind: WatchMetadataKind;
  /**
   * ISO time for `time`; a worker address (`wt:<id>`) for `owner`; a login
   * or name for `person` (an author, shown in tables and details, not on the
   * card's context line); otherwise the text shown.
   */
  value: string;
  /** Hover text, or the label a table or detail view shows beside the value ("author"). */
  label?: string;
}

/** A short source note a table row or detail view can show: a summary, a blocking finding. */
export interface WatchItemNote {
  text: string;
  /** A labelled note collapses under its label; an unlabelled note is one line. */
  label?: string;
  meaning?: WatchStatusMeaning;
}

/** Host-drawn action glyphs, shown beside an action's words and never alone. */
export const WATCH_ACTION_GLYPHS = ['merge', 'draft', 'approve', 'changes', 'publish', 'skip', 'mute', 'unmute'] as const;
export type WatchActionGlyph = (typeof WATCH_ACTION_GLYPHS)[number];

/** Where an action sits: the bar's main button, its ▾ menu, or the Open control at the far right. */
export const WATCH_ACTION_PLACEMENTS = ['primary', 'menu', 'open'] as const;
export type WatchActionPlacement = (typeof WATCH_ACTION_PLACEMENTS)[number];

/**
 * What an action does. A link navigates to a validated target. An effect
 * names an action the source declared in `presentation.actions`; the server
 * resolves it again from cached source state, binds it to the item and its
 * expected revision, and checks authority before running it.
 */
export type WatchItemActionBinding = { link: WatchAttentionTarget } | { effect: { action: string; arguments?: WatchValue } };

/** An explicit confirmation the host shows before running an effect. */
export interface WatchActionConfirmation {
  title: string;
  body: string;
  label: string;
}

/**
 * A human control on an item card. It is data: the host renders the
 * existing button and split-menu pattern, its pending and error feedback,
 * and keeps Open at the far right. Clicking an action never opens or
 * acknowledges the card.
 */
export interface WatchItemAction {
  id: string;
  label: string;
  glyph?: WatchActionGlyph;
  placement: WatchActionPlacement;
  enabled: boolean;
  /** Why a disabled action is blocked, shown as its hover text. */
  reason?: string;
  /** Hover text for an enabled action. */
  title?: string;
  /** Words while the effect runs and once it succeeds. */
  progress?: string;
  done?: string;
  confirm?: WatchActionConfirmation;
  /** Opening this action acknowledges the item's displayed notification revision. */
  acknowledges?: boolean;
  /** A toggle that is on (Cancel merge on a requested merge): the host shows it pressed. */
  pressed?: boolean;
  binding: WatchItemActionBinding;
}

/** The glass surfaces an item can join. Watches inventory is host-owned for every active watch. */
export const WATCH_SURFACES = ['reviews', 'prs', 'watches', 'deck'] as const;
export type WatchSurface = (typeof WATCH_SURFACES)[number];
export interface WatchItemSurfaces {
  list: WatchSurface[];
  /** The item's primary home, when it appears on more than one surface. */
  home?: WatchSurface;
}

/** A source-owned ordering group (a PR stack), kept together on every surface. */
export interface WatchItemGroup {
  id: string;
  title?: string;
  /** The item's place in its group, bottom first; items without one keep their list order. */
  position?: number;
}

/**
 * One item a watch yields. A watch can yield many items; it remains one
 * inventory row itself. Identity is the source-owned ID, stable across
 * revisions; `revision` changes with content or a new formal request.
 */
export interface WatchItem {
  id: string;
  revision: string;
  title: string;
  subtitle?: string;
  /** The item kind, a source-owned word: "pull-request", "document". */
  kind: string;
  glyph: WatchItemGlyph;
  lifecycle: WatchItemLifecycle;
  /** Ordered workflow, attention and health statuses after the lifecycle chip. */
  statuses: WatchItemStatus[];
  attention: WatchItemAttention;
  notification?: WatchItemNotification;
  /** The item waits on the viewer: it counts toward the surface's badge and sorts first. */
  standing?: boolean;
  /** The viewer has answered the current request (posted a review); it now waits on others. */
  answered?: boolean;
  /** The request is no longer open (answered, dismissed, withdrawn): the host shows the item quiet. */
  resolved?: boolean;
  person?: WatchItemPerson;
  metadata: WatchItemMetadata[];
  notes?: WatchItemNote[];
  requestedAt?: string;
  updatedAt?: string;
  /** Where the card opens: a validated external URL or a shell-owned detail view. */
  target?: WatchAttentionTarget;
  actions: WatchItemAction[];
  surfaces: WatchItemSurfaces;
  group?: WatchItemGroup;
  /** The configured repo key, for repo filters; absent when the item belongs to no repo (an ume artifact). */
  repo?: string;
}

/** Fields v2 adds to a source presentation. */
export interface WatchPresentationItems {
  version: 2;
  source: WatchSourceBrand;
  items: WatchItem[];
}

/** The generic brand for a source that supplies none (v1, or a missing logo). */
export function genericSourceBrand(id: string, name = id): WatchSourceBrand {
  return { id, name, icon: { glyph: 'source' } };
}

/** Links navigate only over http(s), to absolute URLs; every other scheme is refused. */
export function validWatchLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Images resolve only over HTTPS: no data, blob, javascript or file URLs, and no credentials. */
export function validWatchAsset(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** A navigation target is a shell route or a validated link. */
export function validWatchTarget(target: WatchAttentionTarget): boolean {
  if ('href' in target) return validWatchLink(target.href);
  if ('hash' in target) return /^#[A-Za-z0-9/_:%.~-]*$/.test(target.hash);
  return !!target.open.key;
}

/** An asset that fails validation falls back to its glyph rather than reaching the page. */
export function resolveWatchIcon(icon: WatchIcon): WatchIcon {
  if ('glyph' in icon) return { glyph: icon.glyph };
  return validWatchAsset(icon.asset.light) && validWatchAsset(icon.asset.dark)
    ? { asset: { light: icon.asset.light, dark: icon.asset.dark }, fallback: icon.fallback }
    : { glyph: icon.fallback };
}

/** The glyph for a lifecycle phase: an installed variant, else the kind glyph. */
export function itemGlyphFor(glyph: WatchItemGlyph, phase: WatchLifecyclePhase): WatchGlyph {
  return glyph.variants?.[phase] ?? glyph.kind;
}

/** Host token aliases, shared by cards, rows and details. Sources never choose them. */
export type WatchHostTone = 'ok' | 'warn' | 'bad' | 'dim';

/** Lifecycle color reuses today's PR tokens: open green, draft grey, completed purple, closed red. */
export const lifecycleToken: Readonly<Record<WatchLifecyclePhase, 'pr-open' | 'pr-draft' | 'pr-merged' | 'pr-closed'>> = {
  active: 'pr-open',
  draft: 'pr-draft',
  completed: 'pr-merged',
  closed: 'pr-closed',
};

/** A status's tone comes from its canonical meaning alone. */
export const statusTone: Readonly<Record<WatchStatusMeaning, WatchHostTone>> = {
  neutral: 'dim',
  pending: 'warn',
  working: 'warn',
  ready: 'ok',
  done: 'ok',
  caution: 'warn',
  'needs-you': 'bad',
  failed: 'bad',
};

/**
 * The card edge for an item, or none. Terminal and archived items have no
 * actionable edge; a completed-purple glyph and a ready-green edge mean
 * different things.
 */
export function attentionEdge(item: Pick<WatchItem, 'attention' | 'lifecycle'>): WatchHostTone | undefined {
  if (item.lifecycle.archived || item.lifecycle.phase === 'completed' || item.lifecycle.phase === 'closed') return undefined;
  return ({ none: 'dim', working: 'warn', ready: 'ok', 'needs-you': 'bad', error: 'bad' } as const)[item.attention];
}

/** Statuses render in the shared order: workflow, then attention, then health; sources keep their order within each. */
export function orderedStatuses(statuses: readonly WatchItemStatus[]): WatchItemStatus[] {
  return WATCH_STATUS_CATEGORIES.flatMap((category) => statuses.filter((status) => status.category === category));
}
