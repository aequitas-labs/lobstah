import { describe, expect, it } from 'vitest';
import { COMMANDS, PROSE, parseArgs, synopsis, usageFor } from '../src/usage.js';
import { toonHelp } from '@lobstah/core';

describe('registry-generated usage (axi P10)', () => {
  it('covers every user-facing command, each with prose', () => {
    const expected = [
      'dispatch', 'ls', 'status', 'logs', 'send', 'inbox', 'attach', 'swap',
      'catch', 'prs', 'cull', 'cancel', 'report', 'watch', 'soak', 'stow',
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

describe('parseArgs — one flag-extraction step (axi P6)', () => {
  const ok = (cmd: string, args: string[]) => {
    const p = parseArgs(cmd, args)!;
    expect(p.error).toBeUndefined();
    return { flags: Object.fromEntries(p.flags), positionals: p.positionals };
  };

  it('accepts known flags and consumes value tokens unexamined', () => {
    expect(ok('dispatch', ['--repo', 'web', '--brief-text', '--looks-like-a-flag', '--chore'])).toEqual({
      flags: { '--repo': 'web', '--brief-text': '--looks-like-a-flag', '--chore': true },
      positionals: [],
    });
  });

  it('extracts flags from any position and returns the rest as positionals', () => {
    const want = { flags: { '--session': 's1' }, positionals: ['abc', 'hello', 'there'] };
    expect(ok('send', ['--session', 's1', 'abc', 'hello', 'there'])).toEqual(want);
    expect(ok('send', ['abc', '--session', 's1', 'hello', 'there'])).toEqual(want);
    expect(ok('send', ['abc', 'hello', 'there', '--session', 's1'])).toEqual(want);
    expect(ok('report', ['abc', 'done', 'fixed', '--pr', 'https://x/1'])).toEqual({
      flags: { '--pr': 'https://x/1' },
      positionals: ['abc', 'done', 'fixed'],
    });
  });

  it('-- ends flag parsing: later tokens are positionals, even flags', () => {
    expect(ok('send', ['abc', '--', '--session', 's1', '--help'])).toEqual({
      flags: {},
      positionals: ['abc', '--session', 's1', '--help'],
    });
  });

  it('rejects an unknown flag with the command named, in any position', () => {
    expect(parseArgs('dispatch', ['--repo', 'web', '--folow-up', 'x'])?.error).toMatch(/--folow-up/);
    expect(parseArgs('ls', ['--al'])?.error).toMatch(/--al/);
    expect(parseArgs('send', ['abc', 'try', '--dry-run', 'first'])?.error).toMatch(/--dry-run/);
  });

  it('rejects a value flag with no value', () => {
    expect(parseArgs('send', ['abc', 'hi', '--session'])?.error).toMatch(/--session needs a value/);
  });

  it('rejects an unknown subverb, allows bare and known ones', () => {
    expect(parseArgs('watch', ['frobnicate'])?.error).toMatch(/frobnicate/);
    expect(ok('watch', []).positionals).toEqual([]);
    expect(ok('watch', ['--check', 'x', 'add', 'ci:1'])).toEqual({ flags: { '--check': 'x' }, positionals: ['add', 'ci:1'] });
    expect(parseArgs('repos', ['somewhere'])?.error).toMatch(/somewhere/);
    expect(ok('pick', ['once']).positionals).toEqual(['once']);
  });

  it('--help before any -- asks for the card', () => {
    expect(parseArgs('dispatch', ['--help'])?.help).toBe(true);
    expect(parseArgs('send', ['abc', '--help'])?.help).toBe(true);
    expect(parseArgs('send', ['abc', '--', '--help'])?.help).toBeUndefined();
  });

  it('positionals that are not subverbs pass where no subverbs exist', () => {
    expect(ok('status', ['abc-123']).positionals).toEqual(['abc-123']);
    expect(ok('logs', ['abc-123', '--follow'])).toEqual({ flags: { '--follow': true }, positionals: ['abc-123'] });
  });

  it('returns undefined for a command outside the registry', () => {
    expect(parseArgs('bogus', [])).toBeUndefined();
  });
});

describe('toonHelp (axi P9)', () => {
  it('renders a counted help block', () => {
    expect(toonHelp(['lobstah status <id>', 'lobstah man tend'])).toBe(
      'help[2]:\n  lobstah status <id>\n  lobstah man tend',
    );
  });
});
