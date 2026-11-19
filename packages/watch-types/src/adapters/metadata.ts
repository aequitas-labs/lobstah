import { prAttentionKinds, prDefaultAttentionKinds } from '../pr/metadata.js';

/** Builtin metadata is composed beside the adapters, independently of configuration parsing. */
export const builtinAttentionKinds = [
  'question',
  'decision',
  'landed',
  ...prAttentionKinds,
  'report',
  'stack-ready',
  'review',
  'dispatch-progress',
] as const;
export const builtinDefaultAttentionKinds = ['question', 'decision', ...prDefaultAttentionKinds] as const;
