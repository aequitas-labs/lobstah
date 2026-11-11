import { describe, expect, it } from 'vitest';
import { codexScreenNote } from '../src/throw.js';

const THREAD = '01a1cc09-0f4e-73c0-8b48-7b1d57b46631';

describe("a throw's note on a Codex pane that never signed on", () => {
  it('names the process holding the thread when Codex says "open in another app"', () => {
    const note = codexScreenNote('  This conversation is open in another app ⏎  Press enter to continue', THREAD, () => [3903]);
    expect(note).toContain('Codex process 3903 still holds');
    expect(note).toContain('--stop-stale');
  });

  it('says what to do when Codex wants hook approval', () => {
    expect(codexScreenNote('  Hooks need review ⏎  7 hooks are new or changed', THREAD)).toContain('re-throw');
    expect(codexScreenNote('• Hook failed ⏎  └ plugin contents changed; hook approval required', THREAD)).toContain('trust');
  });

  it('adds nothing for an ordinary screen', () => {
    expect(codexScreenNote('› Ask Codex to do anything ⏎  ? for shortcuts', THREAD)).toBeUndefined();
  });
});
