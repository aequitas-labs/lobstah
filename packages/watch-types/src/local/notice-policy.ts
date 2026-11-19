/** Routine local transitions remain visible but never request another helm turn. */
export const QUIET_LOCAL_NOTICE_KINDS = [
  'trap-listening',
  'trap-starting',
  'trap-signed-on',
  'trap-stowed',
  'pool-returned',
  'heavy-line-long',
] as const;
