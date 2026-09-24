import { describe, expect, it } from 'vitest';
import { lobItems } from '../src/glass-lobs.js';
import { serveGlass } from '../src/glass.js';
import type { AddressInfo } from 'node:net';

const att = [
  { id: 'aaaa1111', lane: 'work', verb: 'needs-decision', note: 'which color?' },
  { id: 'bbbb2222', lane: 'chore', verb: 'blocked' },
];

describe('lobItems (the crawling lobs on the spyglass page)', () => {
  it('walks one lob per attention item when lobs are on', () => {
    const items = lobItems(att, { lobs: true, preview: false, previewClick: '' });
    expect(items.map((i) => i.key)).toEqual(['question:work:aaaa1111', 'question:chore:bbbb2222']);
    expect(items.map((i) => i.text)).toEqual(['which color?', 'blocked']);
  });

  it('is empty when lobs are off', () => {
    expect(lobItems(att, { lobs: false, preview: false, previewClick: '' })).toEqual([]);
  });

  it('the ?lob preview works only while lobs are on', () => {
    expect(lobItems([], { lobs: true, preview: true, previewClick: '' }).map((i) => i.key)).toEqual(['preview']);
    expect(lobItems([], { lobs: false, preview: true, previewClick: '' })).toEqual([]);
    expect(lobItems([], { lobs: true, preview: false, previewClick: '' })).toEqual([]);
  });

  it('a pr:* item walks as a link to its PR with its kind label, not the modal', () => {
    const items = lobItems(
      [{ id: 'cccc3333', lane: 'work', verb: 'pr:draft', kind: 'pr:draft', note: '#9 draft', prUrl: 'https://github.com/a/b/pull/9' }],
      { lobs: true, preview: false, previewClick: '' },
    );
    expect(items).toEqual([{ key: 'pr:draft:https://github.com/a/b/pull/9', text: '#9 draft', href: 'https://github.com/a/b/pull/9', label: 'draft' }]);
    expect(lobItems([{ id: 'c', lane: 'work', verb: 'pr:ready', kind: 'pr:ready', prUrl: 'x' }], { lobs: false, preview: false, previewClick: '' })).toEqual([]);
  });

  it('labels every kind the way the table and the pet do; a question has none', () => {
    const items = lobItems(
      [
        { id: 'q1', lane: 'work', verb: 'needs-decision', kind: 'question', note: 'which?' },
        { id: 'l1', lane: 'work', verb: 'done', kind: 'landed' },
        { id: 'w1', lane: 'work', verb: 'watch', kind: 'watch' },
      ],
      { lobs: true, preview: false, previewClick: '' },
    );
    expect(items.map((i) => [i.key, i.label])).toEqual([
      ['question:work:q1', ''],
      ['landed:work:l1', 'landed'],
      ['watch:work:w1', 'watch'],
    ]);
    expect(items[0]!.click).toBe("showModal('dispatch','work:q1')");
    expect(items[2]!.click).toBe('');
  });

  it('acked items and this browser\'s hidden lobs do not walk; a new state hash re-shows a hidden one', () => {
    const att = [
      { id: 'a', lane: 'work', verb: 'pr:draft', kind: 'pr:draft', prUrl: 'u', key: 'pr:o/r#1', stateHash: 'h1' },
      { id: 'b', lane: 'work', verb: 'needs-decision', kind: 'question', key: 'work:b', stateHash: 'q1', acked: { at: 'x', by: 'pet' } },
    ];
    const shown = lobItems(att, { lobs: true, preview: false, previewClick: '' });
    expect(shown.map((i) => [i.key, i.hideKey, i.hideHash])).toEqual([['pr:draft:pr:o/r#1', 'pr:o/r#1', 'h1']]);
    expect(lobItems(att, { lobs: true, hidden: { 'pr:o/r#1': 'h1' }, preview: false, previewClick: '' })).toEqual([]);
    expect(lobItems(att, { lobs: true, hidden: { 'pr:o/r#1': 'h0' }, preview: false, previewClick: '' })).toHaveLength(1);
  });

  it('caps at four, the last one counting the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `id${i}`, lane: 'work', verb: 'blocked' }));
    const items = lobItems(many, { lobs: true, preview: false, previewClick: '' });
    expect(items).toHaveLength(4);
    expect(items[3]?.text).toBe('…and 2 more — see attention');
  });

  it('serves no settings endpoint: POST /settings gets the page like any unknown path', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const post = await fetch(`http://127.0.0.1:${port}/settings`, { method: 'POST', body: '{}' });
    const other = await fetch(`http://127.0.0.1:${port}/no-such-path`);
    server.close();
    expect(post.status).toBe(200);
    expect(post.headers.get('content-type')).toBe(other.headers.get('content-type'));
    const [a, b] = [await post.text(), await other.text()];
    expect(a).toBe(b);
    expect(a).not.toContain('glass-token');
  });

  it('the workspace build serves the lob sprite and star as images, so the pixel lob walks (not the emoji fallback)', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    for (const asset of ['/lob-sprite.png', '/star.png']) {
      const res = await fetch(`http://127.0.0.1:${port}${asset}`);
      expect(res.headers.get('content-type'), asset).toBe('image/png');
    }
    server.close();
  });
});
