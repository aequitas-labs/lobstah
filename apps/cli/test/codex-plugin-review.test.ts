import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, loadConfig } from '@lobstah/core';
import type { CodexHookList } from '../src/codex-hook-list.js';
import { answerPluginReview, planPluginReview, pluginReviewSkippedText, pluginReviewWaitingText, pluginReviewWatch } from '../src/codex-plugin-review.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// Codex 0.166's startup screen, as a tmux pane shows it.
const REVIEW = (n: number) => [
  '  Hooks need review',
  `  ${n} ${n === 1 ? 'hook is' : 'hooks are'} new or changed.`,
  '  Hooks can run outside the sandbox after you trust them.',
  '› 1. Review hooks',
  '  2. Trust all and continue',
  "  3. Continue without trusting (hooks won't run)",
  '  enter confirm · esc skip',
].join('\n');
const PROMPT = '› Ask Codex to do anything';

let tmp: string;
let codexHome: string;
let cwd: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-plugin-review-'));
  process.env.LOBSTAH_HOME = path.join(tmp, 'lobstah');
  ensureLayout();
  codexHome = path.join(tmp, 'codex');
  cwd = path.join(tmp, 'checkout');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(cwd);
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(tmp);
});

const hook = (key: string, trustStatus: string, command = 'ume hook stop') => [key, { key, command, currentHash: `sha256:${key.length}/sha256:c`, trustStatus }] as const;
const umeChanged = (): CodexHookList => new Map([
  hook('ume@ume:hooks/hooks.json:session_start:0:0', 'modified', 'ume hook session-start'),
  hook('ume@ume:hooks/hooks.json:stop:0:0', 'modified'),
  hook('notes@acme:hooks/hooks.json:stop:0:0', 'untrusted', 'notes stop'),
  hook('lobstah@lobstah:hooks/hooks.json:stop:0:0', 'untrusted', 'lobstah hook stop'),
  hook('ok@acme:hooks/hooks.json:stop:0:0', 'trusted', 'ok stop'),
]);
const plan = (pluginHooks: 'skip' | 'ask' | 'trust', tmux = true, listed = umeChanged()) =>
  planPluginReview(cwd, { listed, pluginHooks, env: { CODEX_HOME: codexHome }, tmux });

/** A pane that shows `screens` in turn, recording every key sent. */
function pane(screens: string[]) {
  const keys: string[][] = [];
  const run = async (args: string[]) => {
    if (args[0] === 'send-keys') {
      keys.push(args);
      return '';
    }
    return screens.length > 1 ? screens.shift()! : screens[0]!;
  };
  return { run, keys };
}

describe("another plugin's hooks at Codex's hook review", () => {
  it('plans to press Esc only for the skip choice, in tmux, when only other plugins are in the review', () => {
    expect(plan('skip')).toMatchObject({ reviews: [{ plugin: 'ume@ume', hooks: 2 }, { plugin: 'notes@acme', hooks: 1 }], hooks: 3, skip: true });
    expect(plan('ask')?.skip).toBe(false);
    expect(plan('skip', false)?.skip).toBe(false);
    // A user hook in the review too: Esc would skip it as well, so lobstah leaves the review to a person.
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
    expect(plan('skip')).toMatchObject({ hooks: 3, skip: false });
  });

  it('has nothing to plan when every other plugin hook is trusted or disabled', () => {
    expect(plan('skip', true, new Map([hook('ok@acme:hooks/hooks.json:stop:0:0', 'trusted')]))).toBeUndefined();
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[hooks.state."ume@ume:hooks/hooks.json:stop:0:0"]\nenabled=false\n');
    expect(plan('skip', true, new Map([hook('ume@ume:hooks/hooks.json:stop:0:0', 'modified')]))).toBeUndefined();
  });

  it('names the plugin and the one step, in plain words', () => {
    const p = plan('ask')!;
    expect(pluginReviewWaitingText('kind-crab', p)).toBe(
      "Codex needs you to review ume@ume's and notes@acme's hooks; trap kind-crab can't start until you do. " +
        'In its Codex window, press Esc to start without them, or choose "Trust all and continue".',
    );
    expect(pluginReviewSkippedText('kind-crab', p)).toBe(
      "Trap kind-crab started without ume@ume's and notes@acme's hooks because Codex wants them reviewed. " +
        "To run them in traps, trust them once in any Codex session's /hooks.",
    );
  });

  it('presses Esc once the review shows exactly the plugin hooks, and never otherwise', async () => {
    const shown = pane([REVIEW(3)]);
    expect(await answerPluginReview('%4', 3, shown.run)).toBe('pressed');
    expect(shown.keys).toEqual([['send-keys', '-t', '%4', 'Escape']]);
    const other = pane([REVIEW(4)]);
    expect(await answerPluginReview('%4', 3, other.run)).toBe('other');
    const one = pane([REVIEW(1)]);
    expect(await answerPluginReview('%4', 1, one.run)).toBe('pressed');
    const none = pane([PROMPT]);
    expect(await answerPluginReview('%4', 3, none.run)).toBe('none');
    expect([...other.keys, ...none.keys]).toEqual([]);
    expect(await answerPluginReview('%4', 3, async () => { throw new Error('no server'); })).toBe('none');
  });
});

describe('following a launch through the review', () => {
  const kinds = () => listNotices().filter((n) => n.kind === 'codex-plugin-hooks');

  it('skip: waits for the review, presses Esc, then posts what it skipped, once per hook version', async () => {
    const p = plan('skip')!;
    const shown = pane(['Loading…', REVIEW(3), PROMPT]);
    const watch = pluginReviewWatch(p, { label: 'kind-crab', trapId: 't1', repo: 'r', pane: '%4', run: shown.run, started: 1 });
    await watch.tick();
    expect(shown.keys).toEqual([]);
    await watch.tick();
    await watch.tick();
    expect(shown.keys).toEqual([['send-keys', '-t', '%4', 'Escape']]);
    expect(kinds()).toMatchObject([{ refId: 't1', repo: 'r', text: expect.stringMatching(/^Trap kind-crab started without ume@ume's and notes@acme's hooks/) }]);
    // The same plugin versions on the next launch: Esc again, no second notice.
    const again = pane([REVIEW(3)]);
    await pluginReviewWatch(p, { label: 'kind-crab', trapId: 't1', repo: 'r', pane: '%4', run: again.run, started: 2 }).tick();
    expect(again.keys).toHaveLength(1);
    expect(kinds()).toHaveLength(1);
  });

  it('ask, or a terminal lobstah cannot read: posts the blocking notice at launch and sends no key', async () => {
    const shown = pane([REVIEW(3)]);
    const watch = pluginReviewWatch(plan('ask'), { label: 'kind-crab', trapId: 't1', repo: 'r', pane: '%4', run: shown.run, started: 1 });
    await watch.tick();
    pluginReviewWatch(plan('skip', false), { label: 'calm-heron', trapId: 't2', grounds: 'home', started: 1 });
    expect(shown.keys).toEqual([]);
    expect(kinds()).toMatchObject([
      { refId: 't1', repo: 'r', text: expect.stringMatching(/trap kind-crab can't start until you do/) },
      { refId: 't2', grounds: 'home', text: expect.stringMatching(/trap calm-heron can't start until you do\. In its Codex window, press Esc/) },
    ]);
  });

  it('a review that lists more hooks than expected is left to a person, with the blocking notice', async () => {
    const shown = pane([REVIEW(5)]);
    await pluginReviewWatch(plan('skip'), { label: 'kind-crab', trapId: 't1', pane: '%4', run: shown.run, started: 1 }).tick();
    expect(shown.keys).toEqual([]);
    expect(kinds()).toMatchObject([{ text: expect.stringMatching(/can't start until you do/) }]);
  });

  it('no plan: no notice and no key', async () => {
    const shown = pane([REVIEW(3)]);
    await pluginReviewWatch(undefined, { label: 'kind-crab', trapId: 't1', pane: '%4', run: shown.run, started: 1 }).tick();
    expect(shown.keys).toEqual([]);
    expect(kinds()).toEqual([]);
  });
});

describe('[soak] codexPluginHooks', () => {
  const write = (text: string) => fs.writeFileSync(path.join(process.env.LOBSTAH_HOME!, 'config.toml'), text);
  it('defaults to skip, takes ask or trust, and refuses anything else', () => {
    write('');
    expect(loadConfig().soak.codexPluginHooks).toBe('skip');
    write('[soak]\ncodexPluginHooks = "trust"\n');
    expect(loadConfig().soak.codexPluginHooks).toBe('trust');
    write('[soak]\ncodexPluginHooks = "always"\n');
    expect(() => loadConfig()).toThrow(/soak\.codexPluginHooks: unknown choice "always".*"skip", "ask", "trust"/);
  });
});
