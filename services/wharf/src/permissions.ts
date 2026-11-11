import { requireThat } from './protocol.js';

/**
 * What a boat may do. `work` and `mirror` stand apart from the steering
 * layers: `mirror` puts this boat's glass snapshot on the wharf and carries
 * out the calls the hosted glass relays to it, and nothing else.
 */
export const permissions = ['read', 'work', 'helm', 'admin', 'mirror'] as const;
export type Permission = typeof permissions[number];
const steering = ['read', 'helm', 'admin'] as const;
export const personPermissions: Permission[] = ['admin'];
/** Work and mirror are independent; only the highest explicitly granted steering layer is stored. */
export function permits(grants: Permission[], permission: Permission): boolean {
  if (permission === 'work' || permission === 'mirror') return grants.includes(permission);
  return steering.some((layer, index) => grants.includes(layer) && index >= steering.indexOf(permission));
}
export function boatPermissions(value: unknown, confirmAdmin: unknown): Permission[] {
  if (value === undefined) return ['work', 'read'];
  requireThat(Array.isArray(value) && value.length <= permissions.length && value.every((p) => permissions.includes(p)), 400, 'permissions must be a subset of read, work, helm, admin, mirror');
  const selected = [...new Set(value)] as Permission[];
  requireThat(!selected.includes('admin') || confirmAdmin === true, 400, 'admin grants credential management and account deletion; explicitly confirmAdmin to grant it');
  const layer = [...steering].reverse().find((p) => selected.includes(p));
  return [...(selected.includes('work') ? ['work'] as const : []), ...(selected.includes('mirror') ? ['mirror'] as const : []), ...(layer ? [layer] : [])];
}
/** Agent capabilities are checked separately against the dispatch and epoch. */
export function requiredPermission(path: string, method: string): Permission | undefined {
  if (path === 'requests/starts' || path === 'requests/reviews' || /^requests\/[^/]+\/start$/.test(path)) return 'work';
  // A boat's answers to its own cards: a work-only boat runs traps, so it holds permission requests. The card routes check the boat.
  if (path === 'cards/answers' || /^cards\/answers\/[^/]+$/.test(path)) return undefined;
  if (path === '_boat' && method === 'GET') return undefined;
  if (mirrorBoatRoute(path, method)) return 'mirror';
  if (path === '_issue' || path === 'boats' && method === 'POST' || path.startsWith('boats/') && method !== 'GET' || !path && method === 'DELETE') return 'admin';
  if (path === '_claim' || path === 'claims' || path.startsWith('workers/')) return 'work';
  if (path.startsWith('helm/') || path === 'dispatches' && method === 'POST' || /^dispatches\/[^/]+\/(cancel|messages)$/.test(path) && method === 'POST') return 'helm';
  // An acknowledgement is the one write of the read layer: it marks an item seen and changes nothing else.
  if (/^(documents|dispatches)\/[^/]+\/ack$/.test(path) && method === 'POST') return 'read';
  if (method === 'GET') return 'read';
  return undefined;
}
/** The routes a mirror boat calls: put its snapshot, take and answer relayed calls, fetch a relayed answer's files. */
export function mirrorBoatRoute(path: string, method: string): boolean {
  return path === 'mirror/snapshot' && method === 'PUT' || path === 'mirror/calls' && method === 'GET'
    || /^mirror\/calls\/[A-Za-z0-9_-]+\/(take|answer)$/.test(path) && method === 'POST'
    || /^mirror\/files\/[A-Za-z0-9_-]+$/.test(path) && method === 'GET';
}
