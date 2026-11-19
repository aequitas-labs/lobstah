/** Shipped PR attention names and defaults are source declarations. */
export const prAttentionKinds = ['pr:draft', 'pr:review', 'pr:checks', 'pr:conflict', 'pr:ready'] as const;
export const prDefaultAttentionKinds = ['pr:ready', 'pr:review', 'pr:conflict', 'pr:checks'] as const;
export const prWatchAttentionKinds = [
  { kind: 'pr:draft', label: 'Draft', defaultEnabled: false },
  { kind: 'pr:review', label: 'Review', defaultEnabled: true },
  { kind: 'pr:checks', label: 'Checks', defaultEnabled: true },
  { kind: 'pr:conflict', label: 'Conflicts', defaultEnabled: true },
  { kind: 'pr:ready', label: 'Ready to merge', defaultEnabled: true },
];
