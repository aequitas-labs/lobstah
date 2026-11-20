import type { WatchPresentation } from './model.js';
import {
  genericSourceBrand,
  resolveWatchIcon,
  validWatchAsset,
  validWatchLink,
  validWatchTarget,
} from './items.js';
import type { WatchItem, WatchItemAction, WatchItemStatus, WatchPresentationVersion, WatchSourceBrand } from './items.js';

/**
 * One normalized view of a cached presentation, whatever version the source
 * wrote. Consumers render this view and never branch on the version or the
 * source. Normalizing reads only the persisted presentation: it performs no
 * provider read and starts no plugin.
 */
export interface WatchPresentationView {
  version: WatchPresentationVersion;
  source: WatchSourceBrand;
  title: string;
  subtitle: string;
  /** Validated links, each an Open action. */
  links: Array<{ label: string; url: string }>;
  /** A version 1 source's label and tone, adapted to a status here and nowhere else. */
  status?: WatchItemStatus;
  items: WatchItem[];
}

const LEGACY_TONE_MEANING = { neutral: 'neutral', ok: 'ready', warning: 'caution', risk: 'failed' } as const;

/** An effect bound to an action the source no longer declares stays visible but cannot run. */
function normalizeAction(action: WatchItemAction, declared: ReadonlySet<string>): WatchItemAction | undefined {
  if ('link' in action.binding) return validWatchTarget(action.binding.link) ? action : undefined;
  if (declared.has(action.binding.effect.action)) return action;
  return { ...action, enabled: false, reason: action.reason ?? 'This action is no longer available.' };
}

/** Cached items keep their identity; unsafe assets and targets fall back instead of reaching the page. */
function normalizeItem(item: WatchItem, declared: ReadonlySet<string>): WatchItem {
  const { person, target, ...rest } = item;
  return {
    ...rest,
    statuses: (item.statuses ?? []).map(({ target: link, ...status }) => ({
      ...status,
      ...(link && validWatchTarget(link) ? { target: link } : {}),
    })),
    metadata: item.metadata ?? [],
    actions: (item.actions ?? []).flatMap((action) => normalizeAction(action, declared) ?? []),
    surfaces: item.surfaces ?? { list: [] },
    ...(person
      ? {
          person: {
            id: person.id,
            role: person.role,
            ...(person.name ? { name: person.name } : {}),
            ...(person.avatarUrl && validWatchAsset(person.avatarUrl) ? { avatarUrl: person.avatarUrl } : {}),
          },
        }
      : {}),
    ...(target && validWatchTarget(target) ? { target } : {}),
  };
}

/**
 * Normalize a version 1 or version 2 presentation at the boundary. Version
 * 1's title and summary become the title and subtitle, its links remain Open
 * actions, a missing brand gets the generic glyph, and its tone becomes one
 * status. Version 2 keeps its typed axes. `typeId` names the source when the
 * presentation carries no brand of its own.
 */
export function presentationView(presentation: WatchPresentation | undefined, typeId: string): WatchPresentationView {
  const links = (presentation?.links ?? []).filter((link) => validWatchLink(link.url)).map((link) => ({ ...link }));
  if (!presentation) return { version: 1, source: genericSourceBrand(typeId), title: typeId, subtitle: '', links, items: [] };
  if (presentation.version === 2 && presentation.source && Array.isArray(presentation.items)) {
    const declared = new Set(
      presentation.actions.filter((action) => !action.automatic && action.requiresAuthority).map((action) => action.id),
    );
    return {
      version: 2,
      source: { ...presentation.source, icon: resolveWatchIcon(presentation.source.icon) },
      title: presentation.title,
      subtitle: presentation.summary,
      links,
      items: presentation.items.map((item) => normalizeItem(item, declared)),
    };
  }
  return {
    version: 1,
    source: genericSourceBrand(typeId),
    title: presentation.title || typeId,
    subtitle: presentation.summary,
    links,
    ...(presentation.label
      ? {
          status: {
            code: 'legacy-tone',
            label: presentation.label,
            category: 'attention' as const,
            meaning: LEGACY_TONE_MEANING[presentation.tone] ?? 'neutral',
          },
        }
      : {}),
    items: [],
  };
}
