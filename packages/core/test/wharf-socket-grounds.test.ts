import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/wharf-socket.js';

describe('a mirror boat’s grounds message', () => {
  it('carries its local grounds names, once each and sorted', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'grounds', grounds: ['home', 'away', 'home'] }))).toEqual({ t: 'grounds', grounds: ['away', 'home'] });
    expect(parseClientMessage(JSON.stringify({ t: 'grounds', grounds: [] }))).toEqual({ t: 'grounds', grounds: [] });
  });
  it('refuses anything but a short list of grounds names', () => {
    for (const grounds of ['home', [1], ['a b'], ['x'.repeat(129)], Array.from({ length: 33 }, (_, i) => `g${i}`)]) {
      expect(parseClientMessage(JSON.stringify({ t: 'grounds', grounds }))).toHaveProperty('invalid');
    }
  });
});
