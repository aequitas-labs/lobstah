import { requireThat } from './protocol.js';

export const permissions = ['read', 'work', 'helm', 'admin'] as const;
export type Permission = typeof permissions[number];
export const personPermissions: Permission[] = ['read', 'helm', 'admin'];
export function boatPermissions(value: unknown, confirmAdmin: unknown): Permission[] {
  if (value === undefined) return ['work'];
  requireThat(Array.isArray(value) && value.length <= permissions.length && value.every((p) => permissions.includes(p)), 400, 'permissions must be a subset of read, work, helm, admin');
  const selected = [...new Set(value)] as Permission[];
  requireThat(!selected.includes('admin') || confirmAdmin === true, 400, 'admin grants credential management and account deletion; explicitly confirmAdmin to grant it');
  return selected;
}
/** Agent capabilities are checked separately against the dispatch and epoch. */
export function requiredPermission(path: string, method: string): Permission | undefined {
  if (path === '_issue' || path === 'boats' && method === 'POST' || path.startsWith('boats/') && method !== 'GET' || !path && method === 'DELETE') return 'admin';
  if (path === '_claim' || path === 'claims' || path.startsWith('workers/')) return 'work';
  if (path.startsWith('helm/') || path === 'dispatches' && method === 'POST' || /^dispatches\/[^/]+\/(cancel|messages)$/.test(path) && method === 'POST') return 'helm';
  if (method === 'GET') return 'read';
  return undefined;
}
