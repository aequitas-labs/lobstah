import { describe, expect, it } from 'vitest';
import { COMMANDS, PROSE, synopsis, usageFor, validateArgs } from '../src/usage.js';
import { toonHelp } from '@lobstah/core';

describe('registry-generated usage (axi P10)', () => {
  it('covers every user-facing command, each with prose', () => {
    const expected = [
      'dispatch', 'ls', 'status', 'logs', 'send', 'inbox', 'attach', 'swap',
      'catch', 'cull', 'cancel', 'report', 'watch', 'soak', 'stow',
      'daemon', 'pick', 'doctor', 'repos', 'init', 'version',
      'man:manual', 'man:tend', 'man:wait', 'man:init', 'man:haul', 'man:brief',
    ];
    for (const cmd of expected) {
      expect(COMMANDS[cmd], cmd).toBeDefined();
      expect(PROSE[cmd], cmd).toBeDefined();
    }
  });

  it('the synopsis carries every registered flag, so help can never omit one', () => {
    for (const [cmd, spec] of Object.entries(COMMANDS)) {
      const syn = synopsis(cmd);
      for (const flag of Object.keys(spec.flags)) expect(syn, `${cmd} ${flag}`).toContain(flag);
      if (spec.subverbs) for (const s of spec.subverbs) expect(syn, cmd).toContain(s);
    }
  });

  it('cards stay concise — a reference card, not a manual', () => {
    for (const cmd of Object.keys(COMMANDS)) {
      const card = usageFor(cmd)!;
      expect(card.split('\n').length, cmd).toBeLessThanOrEqual(8);
      expect(card.startsWith('lobstah '), cmd).toBe(true);
    }
  });
});

describe('validateArgs (axi P6)', () => {
  it('accepts known flags and consumes value tokens unexamined', () => {
    expect(validateArgs('dispatch', ['--repo', 'web', '--brief-text', '--looks-like-a-flag', '--chore'])).toEqual({});
  });

  it('rejects an unknown flag with the command named', () => {
    expect(validateArgs('dispatch', ['--repo', 'web', '--folow-up', 'x'])?.error).toMatch(/--folow-up/);
    expect(validateArgs('ls', ['--al'])?.error).toMatch(/--al/);
  });

  it('rejects an unknown subverb, allows bare and known ones', () => {
    expect(validateArgs('watch', ['frobnicate'])?.error).toMatch(/frobnicate/);
    expect(validateArgs('watch', [])).toEqual({});
    expect(validateArgs('watch', ['add', 'ci:1', '--check', 'x'])).toEqual({});
    expect(validateArgs('repos', ['somewhere'])?.error).toMatch(/somewhere/);
    expect(validateArgs('pick', ['once'])).toEqual({});
  });

  it('stops validating at a free-text tail', () => {
    expect(validateArgs('send', ['abc', 'try', '--dry-run', 'first'])).toEqual({});
    expect(validateArgs('report', ['abc', 'done', 'fixed', '--pr', 'https://x/1'])).toEqual({});
  });

  it('--help in the validated region asks for the card; in a tail it is prose', () => {
    expect(validateArgs('dispatch', ['--help'])).toEqual({ help: true });
    expect(validateArgs('send', ['abc', '--help', 'is', 'broken'])).toEqual({});
  });

  it('positionals that are not subverbs pass where no subverbs exist', () => {
    expect(validateArgs('status', ['abc-123'])).toEqual({});
    expect(validateArgs('logs', ['abc-123', '--follow'])).toEqual({});
  });

  it('returns undefined for a command outside the registry', () => {
    expect(validateArgs('bogus', [])).toBeUndefined();
  });
});

describe('toonHelp (axi P9)', () => {
  it('renders a counted help block', () => {
    expect(toonHelp(['lobstah status <id>', 'lobstah man tend'])).toBe(
      'help[2]:\n  lobstah status <id>\n  lobstah man tend',
    );
  });
});
