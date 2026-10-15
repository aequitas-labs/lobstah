/**
 * The page's place, as its URL hash: a view (`#jobs`), or one item open over
 * its view (`#decision/<id>`, `#report/<id>`, `#review/<id>`, `#job/<id>`, `#trap/<id>`).
 * A link from outside (the pet, a message) opens the glass on that item.
 */
export const TABS = ['deck', 'jobs', 'traps', 'boats', 'reviews', 'reports'] as const;
export type Tab = (typeof TABS)[number];
/** The view an item is listed in: where a link to it lands, and what stays when it closes. */
const HOME = { decision: 'deck', report: 'reports', review: 'reviews', job: 'jobs', trap: 'traps' } as const;
export type ItemKind = keyof typeof HOME;
export interface Item {
  kind: ItemKind;
  id: string;
}
export interface Route {
  tab: Tab;
  item?: Item;
}
/** An unknown or malformed hash is the deck. Ids are the wharf's own identifier characters only. */
export function parseRoute(hash: string): Route {
  const item = /^#(decision|report|review|job|trap)\/([A-Za-z0-9_-]{1,128})$/.exec(hash);
  if (item) {
    const kind = item[1] as ItemKind;
    return { tab: HOME[kind], item: { kind, id: item[2]! } };
  }
  const tab = TABS.find((t) => hash === '#' + t);
  return { tab: tab ?? 'deck' };
}
export function routeHash(route: Route): string {
  return route.item ? `#${route.item.kind}/${route.item.id}` : '#' + route.tab;
}
