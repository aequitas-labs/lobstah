import { describe, expect, it } from 'vitest';
import { modelForHarness, modelHarness } from '../src/models.js';

describe('modelHarness — a model id names its harness', () => {
  it.each([
    ['claude-opus-5-5', 'claude'],
    ['claude-sonnet-4-5', 'claude'],
    ['opus', 'claude'],
    ['sonnet', 'claude'],
    ['opusplan', 'claude'],
    ['gpt-5.2-codex', 'codex'],
    ['o3', 'codex'],
    ['o4-mini', 'codex'],
    ['codex-mini-latest', 'codex'],
    ['llama3', undefined],
    ['openrouter/auto', undefined],
  ])('%s → %s', (model, harness) => {
    expect(modelHarness(model)).toBe(harness);
  });
});

describe('modelForHarness — a model never crosses harnesses', () => {
  it('drops a claude model on codex and a gpt model on claude', () => {
    expect(modelForHarness('codex', 'claude-opus-5-5')).toEqual({ dropped: { model: 'claude-opus-5-5', owner: 'claude' } });
    expect(modelForHarness('claude', 'gpt-5')).toEqual({ dropped: { model: 'gpt-5', owner: 'codex' } });
  });
  it('keeps a matching or unknown model', () => {
    expect(modelForHarness('claude', 'claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5' });
    expect(modelForHarness('codex', 'llama3')).toEqual({ model: 'llama3' });
    expect(modelForHarness('codex', undefined)).toEqual({ model: undefined });
  });
});
