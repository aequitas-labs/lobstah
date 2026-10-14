/** Wire choices shared with the receiver. No I/O, identifiers or credentials. */
export const USAGE_BUCKETS = ['0', '1', '2', '3-5', '6-10', '11+'] as const;
export const GROUNDS_BUCKETS = ['0', '1', '2', '3-5', '6+'] as const;
export const HELM_COUNTS = ['none', 'one', 'several'] as const;
export const WHARF_KINDS = ['none', 'hosted', 'self-hosted', 'both'] as const;
export type UsageBucket = typeof USAGE_BUCKETS[number];
export type GroundsBucket = typeof GROUNDS_BUCKETS[number];
export interface BoatAccess { work: boolean | null; read: boolean | null; helm: boolean | null }
export interface CatchUsage {
  withHelm: UsageBucket; withoutHelm: UsageBucket; helmUnknown: UsageBucket;
  onLocal: UsageBucket; onWharf: UsageBucket; locationUnknown: UsageBucket;
}
export const UNKNOWN_ACCESS: BoatAccess = { work: null, read: null, helm: null };
export function usageBucket(n: number): UsageBucket {
  return n <= 0 ? '0' : n === 1 ? '1' : n === 2 ? '2' : n <= 5 ? '3-5' : n <= 10 ? '6-10' : '11+';
}
export function groundsBucket(n: number): GroundsBucket {
  return n > 5 ? '6+' : usageBucket(n) as GroundsBucket;
}
export function accessFlags(permissions: readonly unknown[]): BoatAccess {
  const admin = permissions.includes('admin');
  return { work: admin || permissions.includes('work'), read: admin || permissions.includes('read') || permissions.includes('helm'), helm: admin || permissions.includes('helm') };
}
export const CATCH_USAGE_KEYS = ['withHelm', 'withoutHelm', 'helmUnknown', 'onLocal', 'onWharf', 'locationUnknown'] as const;
/** Copy known choices only; nested free text never crosses the wire. */
export function safeCatchUsage(v: CatchUsage): CatchUsage {
  const bucket = (k: keyof CatchUsage): UsageBucket => USAGE_BUCKETS.includes(v?.[k]) ? v[k] : '0';
  return { withHelm: bucket('withHelm'), withoutHelm: bucket('withoutHelm'), helmUnknown: bucket('helmUnknown'),
    onLocal: bucket('onLocal'), onWharf: bucket('onWharf'), locationUnknown: bucket('locationUnknown') };
}
export function safeAccess(v: BoatAccess | undefined): BoatAccess {
  const flag = (k: keyof BoatAccess) => typeof v?.[k] === 'boolean' ? v[k] : null;
  return { work: flag('work'), read: flag('read'), helm: flag('helm') };
}
