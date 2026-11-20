import { describe, expect, it } from 'vitest';
import {
  attentionEdge,
  itemGlyphFor,
  lifecycleToken,
  orderedStatuses,
  presentationView,
  statusTone,
  validatePluginManifest,
  validateWatchPresentation,
  WatchPluginError,
} from '../src/index.js';
import type { WatchItem, WatchPresentation } from '../src/index.js';
import { watchPluginManifest } from '../src/plugin-server.js';
import { CommandWatchType } from '../src/command.js';

const base: WatchPresentation = {
  title: 'Incoming reviews',
  summary: '1 review requested',
  label: 'Reviews',
  tone: 'neutral',
  worker: { steps: [] },
  helm: { steps: [] },
  rows: [],
  links: [{ label: 'Open', url: 'https://app.ume.so/a/plan' }],
  actions: [
    { id: 'publish', label: 'Publish', requiresAuthority: true, arguments: { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['comment', 'approve'] } }, additionalProperties: false } },
    { id: 'reconcile', label: 'Reconcile', requiresAuthority: true, automatic: true },
  ],
  attention: [],
};

const item = (extra: Partial<WatchItem> = {}): WatchItem => ({
  id: 'review:aequitas/lobstah#539',
  revision: 'r1',
  title: 'Keep review drafts visible',
  kind: 'pull-request',
  glyph: { kind: 'pull-request' },
  lifecycle: { phase: 'active', label: 'Open' },
  statuses: [{ code: 'drafted', label: 'draft ready', category: 'workflow', meaning: 'pending' }],
  attention: 'needs-you',
  notification: { revision: 'n1', unread: true },
  metadata: [
    { kind: 'project', value: 'lobstah' },
    { kind: 'time', value: '2026-11-19T00:00:00.000Z' },
    { kind: 'reference', value: '#539' },
  ],
  actions: [
    { id: 'publish', label: 'Publish comment', placement: 'primary', enabled: true, binding: { effect: { action: 'publish', arguments: { verdict: 'comment' } } } },
    { id: 'open', label: 'Open', placement: 'open', enabled: true, binding: { link: { href: 'https://github.com/aequitas/lobstah/pull/539' } } },
  ],
  surfaces: { list: ['reviews'], home: 'reviews' },
  ...extra,
});

const v2 = (items: WatchItem[] = [item()], extra: Record<string, unknown> = {}): WatchPresentation =>
  ({ ...base, version: 2, source: { id: 'github', name: 'GitHub', icon: { glyph: 'github' } }, items, ...extra }) as WatchPresentation;

describe('presentation v2 contract', () => {
  it('accepts typed items and keeps version 1 strict', () => {
    expect(validateWatchPresentation(v2()).items).toHaveLength(1);
    const { arguments: _schema, ...publish } = base.actions[0]!;
    const v1 = { ...base, actions: [publish, base.actions[1]!] };
    expect(validateWatchPresentation(v1).version).toBeUndefined();
    // A version 1 source cannot add the new fields, and a version 2 source must declare them all.
    expect(() => validateWatchPresentation({ ...v1, items: [] }, 1)).toThrow(WatchPluginError);
    expect(() => validateWatchPresentation(v2(), 1)).toThrow(WatchPluginError);
    expect(() => validateWatchPresentation(v1, 2)).toThrow(WatchPluginError);
    const { source: _source, ...unbranded } = v2();
    expect(() => validateWatchPresentation(unbranded)).toThrow(WatchPluginError);
  });

  it('rejects source colors, classes, layout and markup', () => {
    for (const extra of [
      { color: '#ff0000' },
      { className: 'gcard-edge' },
      { layout: 'wide' },
      { html: '<b>x</b>' },
    ]) {
      expect(() => validateWatchPresentation(v2([{ ...item(), ...extra } as WatchItem]))).toThrow(WatchPluginError);
    }
    expect(() => validateWatchPresentation(v2([item({ statuses: [{ code: 'x', label: 'x', category: 'workflow', meaning: 'pending', tone: 'bad' } as never] })]))).toThrow(WatchPluginError);
    expect(() => validateWatchPresentation(v2(undefined, { source: { id: 'github', name: 'GitHub', icon: { glyph: 'github' }, color: '#000' } }))).toThrow(WatchPluginError);
    expect(() => validateWatchPresentation(v2([item({ lifecycle: { phase: 'merged' as never, label: 'Merged' } })]))).toThrow(WatchPluginError);
  });

  it('rejects action bindings that do not resolve to a declared human action', () => {
    const effect = (action: string, args?: unknown) =>
      item({ actions: [{ id: 'act', label: 'Act', placement: 'primary', enabled: true, binding: { effect: { action, ...(args === undefined ? {} : { arguments: args as never }) } } }] });
    expect(() => validateWatchPresentation(v2([effect('missing')]))).toThrow('undeclared human action');
    expect(() => validateWatchPresentation(v2([effect('reconcile')]))).toThrow('undeclared human action');
    expect(() => validateWatchPresentation(v2([effect('publish', { verdict: 'merge' })]))).toThrow('arguments');
    expect(() => validateWatchPresentation(v2([effect('publish', { verdict: 'approve' })]))).not.toThrow();
    expect(() =>
      validateWatchPresentation(v2([item({ actions: [{ id: 'go', label: 'Go', placement: 'open', enabled: true, binding: { link: { href: 'javascript:alert(1)' } } }] })])),
    ).toThrow('invalid target');
    expect(() => validateWatchPresentation(v2([item(), item()]))).toThrow('repeats item');
    expect(() => validateWatchPresentation(v2([item({ notification: { revision: 'n1', unread: true, action: 'missing' } })]))).toThrow(
      'acknowledges through an undeclared human action',
    );
  });

  it('declares and refuses presentation versions in the plugin handshake', () => {
    const adapter = new CommandWatchType();
    const expected = { id: adapter.descriptor.id, version: adapter.descriptor.version, apiVersion: 1 as const };
    expect(validatePluginManifest(watchPluginManifest(adapter), expected).presentationVersion).toBe(1);
    expect(validatePluginManifest(watchPluginManifest(adapter, { presentationVersion: 2 }), expected).presentationVersion).toBe(2);
    expect(() => validatePluginManifest({ ...watchPluginManifest(adapter), presentationVersion: 3 }, expected)).toThrow(WatchPluginError);
  });
});

describe('normalized presentation view', () => {
  it('adapts a cached version 1 presentation without a provider read', () => {
    const view = presentationView(
      { ...base, tone: 'risk', label: 'Access expired', links: [{ label: 'Open', url: 'https://example.test' }, { label: 'Bad', url: 'javascript:alert(1)' }] },
      'deployment',
    );
    expect(view).toMatchObject({
      version: 1,
      source: { id: 'deployment', name: 'deployment', icon: { glyph: 'source' } },
      title: 'Incoming reviews',
      subtitle: '1 review requested',
      links: [{ label: 'Open', url: 'https://example.test' }],
      status: { label: 'Access expired', meaning: 'failed' },
      items: [],
    });
    expect(presentationView(undefined, 'deployment')).toMatchObject({ version: 1, title: 'deployment', items: [] });
  });

  it('keeps brand and lifecycle glyphs apart and falls back from corrupt assets', () => {
    const view = presentationView(
      v2([item({ person: { id: 'octo', role: 'requested by', avatarUrl: 'data:image/png;base64,AAAA' } })], {
        source: { id: 'ume', name: 'ume', icon: { asset: { light: 'javascript:alert(1)', dark: 'https://ume.so/blossom-dark.png' }, fallback: 'ume' } },
      }),
      'ume-reviews',
    );
    expect(view.source).toEqual({ id: 'ume', name: 'ume', icon: { glyph: 'ume' } });
    expect(view.items[0]!.glyph).toEqual({ kind: 'pull-request' });
    expect(view.items[0]!.person).toEqual({ id: 'octo', role: 'requested by' });
    const safe = presentationView(
      v2(undefined, { source: { id: 'ume', name: 'ume', icon: { asset: { light: 'https://ume.so/l.png', dark: 'https://ume.so/d.png' }, fallback: 'ume' } } }),
      'ume-reviews',
    );
    expect(safe.source.icon).toEqual({ asset: { light: 'https://ume.so/l.png', dark: 'https://ume.so/d.png' }, fallback: 'ume' });
    expect(itemGlyphFor({ kind: 'document', variants: { completed: 'document-check' } }, 'completed')).toBe('document-check');
    expect(itemGlyphFor({ kind: 'document', variants: { completed: 'document-check' } }, 'active')).toBe('document');
  });

  it('disables a cached effect whose action the source no longer declares', () => {
    const presentation = v2();
    const view = presentationView({ ...presentation, actions: [] }, 'review-requests');
    expect(view.items[0]!.actions[0]).toMatchObject({ id: 'publish', enabled: false, reason: 'This action is no longer available.' });
    expect(view.items[0]!.actions[1]).toMatchObject({ id: 'open', enabled: true });
    const acknowledged = presentationView({ ...v2([item({ notification: { revision: 'n1', unread: true, action: 'publish' } })]), actions: [] }, 'review-requests');
    expect(acknowledged.items[0]!.notification).toEqual({ revision: 'n1', unread: true });
  });
});

describe('separate lifecycle, attention and seen axes', () => {
  const phases = [
    ['active', 'pr-open'],
    ['draft', 'pr-draft'],
    ['completed', 'pr-merged'],
    ['closed', 'pr-closed'],
  ] as const;
  it.each(phases)('maps %s to the existing lifecycle token', (phase, token) => {
    expect(lifecycleToken[phase]).toBe(token);
  });

  it('shows no actionable edge on terminal or archived items', () => {
    expect(attentionEdge({ attention: 'needs-you', lifecycle: { phase: 'active', label: 'Open' } })).toBe('bad');
    expect(attentionEdge({ attention: 'error', lifecycle: { phase: 'draft', label: 'Draft' } })).toBe('bad');
    expect(attentionEdge({ attention: 'working', lifecycle: { phase: 'active', label: 'Open' } })).toBe('warn');
    expect(attentionEdge({ attention: 'ready', lifecycle: { phase: 'active', label: 'Open' } })).toBe('ok');
    expect(attentionEdge({ attention: 'ready', lifecycle: { phase: 'completed', label: 'Merged' } })).toBeUndefined();
    expect(attentionEdge({ attention: 'error', lifecycle: { phase: 'closed', label: 'Closed' } })).toBeUndefined();
    expect(attentionEdge({ attention: 'needs-you', lifecycle: { phase: 'active', label: 'Open', archived: true } })).toBeUndefined();
  });

  it('preserves a completed phase when an item is archived', () => {
    const view = presentationView(v2([item({ lifecycle: { phase: 'completed', label: 'Approved', archived: true }, attention: 'none' })]), 'ume-reviews');
    expect(view.items[0]!.lifecycle).toEqual({ phase: 'completed', label: 'Approved', archived: true });
    expect(lifecycleToken[view.items[0]!.lifecycle.phase]).toBe('pr-merged');
  });

  it('orders statuses by category and colors them by meaning alone', () => {
    const ordered = orderedStatuses([
      { code: 'held', label: 'held', category: 'health', meaning: 'failed' },
      { code: 'unread', label: 'needs you', category: 'attention', meaning: 'needs-you' },
      { code: 'drafted', label: 'draft ready', category: 'workflow', meaning: 'pending' },
    ]);
    expect(ordered.map((status) => status.category)).toEqual(['workflow', 'attention', 'health']);
    expect(statusTone.pending).toBe('warn');
    expect(statusTone['needs-you']).toBe('bad');
    expect(statusTone.ready).toBe('ok');
  });
});
