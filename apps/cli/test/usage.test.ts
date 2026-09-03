import { describe, expect, it } from 'vitest';
import { USAGE, usageFor } from '../src/usage.js';
import { toonHelp } from '@lobstah/core';

describe('per-command usage (axi P10)', () => {
  it('covers every user-facing command', () => {
    const expected = [
      'dispatch', 'ls', 'status', 'logs', 'send', 'inbox', 'attach', 'swap',
      'catch', 'cull', 'cancel', 'report', 'watch', 'soak', 'stow',
      'daemon', 'pick', 'doctor', 'repos', 'init', 'version',
      'man:tend', 'man:wait', 'man:init', 'man:haul', 'man:brief',
    ];
    for (const cmd of expected) expect(usageFor(cmd), cmd).toBeDefined();
  });

  it('entries stay concise — a usage block is a reference card, not a manual', () => {
    for (const [cmd, text] of Object.entries(USAGE)) {
      expect(text.split('\n').length, cmd).toBeLessThanOrEqual(6);
      expect(text.startsWith('lobstah '), cmd).toBe(true);
    }
  });
});

describe('toonHelp (axi P9)', () => {
  it('renders a counted help block', () => {
    expect(toonHelp(['lobstah status <id>', 'lobstah man tend'])).toBe(
      'help[2]:\n  lobstah status <id>\n  lobstah man tend',
    );
  });
});
