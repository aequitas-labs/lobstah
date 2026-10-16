import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRIEF_KINDS, loadConfig, withBriefHooks } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-brief-hooks-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('[repos.<key>.hooks.brief]', () => {
  it('each kind gets its own text, then the all text; a repo with none is unchanged', () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      [
        '[repos.web]',
        'path = "/w"',
        '[repos.web.hooks.brief]',
        ...BRIEF_KINDS.map((k) => `${k} = "Then run the ${k} step."`),
        'all = """',
        'Finally, run /pr-refresh.',
        '"""',
        'unknown = "ignored"',
        '[repos.api]',
        'path = "/a"',
        '[repos.api.hooks.brief]',
        'checks = "   "',
      ].join('\n'),
    );
    const cfg = loadConfig();
    expect(cfg.repos.web!.hooks?.brief).toEqual({
      ...Object.fromEntries(BRIEF_KINDS.map((k) => [k, `Then run the ${k} step.`])),
      all: 'Finally, run /pr-refresh.',
    });
    for (const kind of BRIEF_KINDS) {
      expect(withBriefHooks('Repair it. Push.', cfg, 'web', kind)).toBe(`Repair it. Push.\n\nThen run the ${kind} step.\n\nFinally, run /pr-refresh.`);
    }
    // A blank hook is none; an unknown key is ignored.
    expect(cfg.repos.api!.hooks).toBeUndefined();
    expect(withBriefHooks('Repair it. Push.', cfg, 'api', 'checks')).toBe('Repair it. Push.');
    expect(withBriefHooks('Repair it. Push.', cfg, undefined, 'rebase')).toBe('Repair it. Push.');
  });

  it('all alone applies to every kind', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.web]\npath = "/w"\n[repos.web.hooks.brief]\nall = "Run the repo refresh."\n');
    const cfg = loadConfig();
    for (const kind of BRIEF_KINDS) expect(withBriefHooks('B', cfg, 'web', kind)).toBe('B\n\nRun the repo refresh.');
  });
});

describe('[hooks.brief]', () => {
  it('global text comes first, then the repo text, kind before all at each level', () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      ['[hooks.brief]', 'prReview = "Global review rules."', 'all = "Global all."', '[repos.web]', 'path = "/w"', '[repos.web.hooks.brief]', 'prReview = "Repo review rules."', 'all = "Repo all."', '[repos.api]', 'path = "/a"'].join('\n'),
    );
    const cfg = loadConfig();
    expect(withBriefHooks('B', cfg, 'web', 'prReview')).toBe('B\n\nGlobal review rules.\n\nGlobal all.\n\nRepo review rules.\n\nRepo all.');
    expect(withBriefHooks('B', cfg, 'api', 'prReview')).toBe('B\n\nGlobal review rules.\n\nGlobal all.');
    expect(withBriefHooks('B', cfg, 'api', 'checks')).toBe('B\n\nGlobal all.');
  });
});

describe('[hooks.notify] and [hooks.pickupNotify]', () => {
  it('reads command and verbs', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), ['[hooks.notify]', 'command = "ntfy pub t"', 'verbs = ["done"]', '[hooks.pickupNotify]', 'command = "say picked"'].join('\n'));
    expect(loadConfig().hooks).toEqual({ notify: { command: 'ntfy pub t', verbs: ['done'] }, pickupNotify: { command: 'say picked' }, brief: {} });
  });

  it('refuses a table without its command', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[hooks.notify]\nverbs = ["done"]\n');
    expect(() => loadConfig()).toThrow('[hooks.notify].command must be a command line');
  });
});

describe('moved keys', () => {
  it.each([
    ['notifyCommand = "x"', 'notifyCommand moved to [hooks.notify].command'],
    ['notifyVerbs = ["done"]', 'notifyVerbs moved to [hooks.notify].verbs'],
    ['[pickup]\nnotifyCommand = "x"', '[pickup].notifyCommand moved to [hooks.pickupNotify].command'],
    ['[reviews]\nrules = "x"', '[reviews].rules moved to [hooks.brief].prReview'],
    ['[repos.web]\npath = "/w"\n[repos.web.briefHooks]\nall = "x"', '[repos.web.briefHooks] moved to [repos.web.hooks.brief]'],
    ['[repos.web]\npath = "/w"\nreview = "graphite"', '[repos.web].review moved to [repos.web].reviewTool'],
    ['[repos.web]\npath = "/w"\n[repos.web.reviews]\nrules = "x"', '[repos.web.reviews].rules moved to [repos.web.hooks.brief].prReview'],
  ])('refuses %s, naming its new place', (toml, why) => {
    fs.writeFileSync(path.join(home, 'config.toml'), `${toml}\n`);
    expect(() => loadConfig()).toThrow(why);
  });

  it('names every moved key at once', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), 'notifyCommand = "x"\nnotifyVerbs = ["done"]\n');
    expect(() => loadConfig()).toThrow('notifyCommand moved to [hooks.notify].command; notifyVerbs moved to [hooks.notify].verbs');
  });
});
