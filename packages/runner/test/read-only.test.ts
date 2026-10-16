import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@lobstah/core';
import { remotePolicyFor } from '../src/run.js';

describe('a read-only job', () => {
  it('pushes nothing, opens no PR and checkpoints nothing, whatever the repo says', () => {
    const cfg = { limits: { ...DEFAULT_LIMITS, pushEarly: true, draftPr: true, checkpointOnStop: true } };
    const repo = { pushEarly: true, draftPr: true, checkpointOnStop: true };
    expect(remotePolicyFor({ readOnly: true }, repo, cfg)).toEqual({ pushEarly: false, draftPr: false, checkpointOnStop: false });
    expect(remotePolicyFor({}, { draftPr: false }, cfg)).toEqual({ pushEarly: true, draftPr: false, checkpointOnStop: true });
  });
});
