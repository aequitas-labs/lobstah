import { describe, expect, it } from 'vitest';
import { lobItems } from '../src/glass-lobs.js';
import { serveGlass } from '../src/glass.js';
import type { AddressInfo } from 'node:net';

const att = [
  { id: 'aaaa1111', lane: 'work', verb: 'needs-decision', note: 'which color?' },
  { id: 'bbbb2222', lane: 'chore', verb: 'blocked' },
];

describe('lobItems (the crawling lobs on the spyglass page)', () => {
  it('walks one lob per attention item when glass.pet is on', () => {
    const items = lobItems(att, { pet: true, preview: false, previewClick: '' });
    expect(items.map((i) => i.key)).toEqual(['work:aaaa1111', 'chore:bbbb2222']);
    expect(items.map((i) => i.text)).toEqual(['which color?', 'blocked']);
  });

  it('is empty when glass.pet is false', () => {
    expect(lobItems(att, { pet: false, preview: false, previewClick: '' })).toEqual([]);
  });

  it('the ?lob preview works only while the setting is on', () => {
    expect(lobItems([], { pet: true, preview: true, previewClick: '' }).map((i) => i.key)).toEqual(['preview']);
    expect(lobItems([], { pet: false, preview: true, previewClick: '' })).toEqual([]);
    expect(lobItems([], { pet: true, preview: false, previewClick: '' })).toEqual([]);
  });

  it('caps at four, the last one counting the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `id${i}`, lane: 'work', verb: 'blocked' }));
    const items = lobItems(many, { pet: true, preview: false, previewClick: '' });
    expect(items).toHaveLength(4);
    expect(items[3]?.text).toBe('…and 2 more — see attention');
  });

  it('the page embeds this exact function', async () => {
    const server = serveGlass(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    server.close();
    expect(page).toContain(lobItems.toString());
    expect(page).toContain('lobItems(att,{pet:window.glassPet===true');
  });
});
