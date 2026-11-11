import { describe, expect, it } from 'vitest';
import { paneTrapName, planPaneTidy, type PaneInfo, type ProcInfo, type ThreadUse } from '../src/tidy-panes.js';

const CODEX = '/usr/local/lib/node_modules/@openai/codex/vendor/bin/codex -c check_for_update_on_startup=false';
const HELPER = '/usr/local/lib/node_modules/@openai/codex/vendor/bin/codex-code-mode-host';
const T1 = '01a1cc09-0f4e-73c0-8b48-7b1d57b46631';
const T2 = '01a1cbec-a41f-7000-8000-000000000000';

/** A pane whose own process is Codex (as tmux runs it), with Codex's helper under it. */
function codexPane(pane: string, title: string, pid: number): { pane: PaneInfo; procs: ProcInfo[] } {
  return { pane: { pane, dead: false, pid, title }, procs: [{ pid, ppid: 1, command: CODEX }, { pid: pid + 1, ppid: pid, command: HELPER }] };
}

describe('tidying lobstah panes', () => {
  it("reads the trap a pane's title names", () => {
    expect(paneTrapName('homebase · dune-harbor')).toBe('dune-harbor');
    expect(paneTrapName('homebase _ dune-harbor')).toBe('dune-harbor');
    expect(paneTrapName('mac.lan')).toBeUndefined();
  });

  it("keeps each live trap's own pane, and stops duplicates, leftovers and dead panes", () => {
    const own = codexPane('%50', 'homebase _ dune-harbor', 500);
    const duplicate = codexPane('%19', 'homebase _ dune-harbor', 190);
    const leftover = codexPane('%3', 'homebase _ fresh-cove', 30);
    const shell: PaneInfo = { pane: '%5', dead: false, pid: 50, title: 'homebase _ early-cove' };
    const dead: PaneInfo = { pane: '%7', dead: true, pid: 70, title: 'homebase _ glad-heron' };
    const traps = [{ name: 'dune-harbor', sessionId: T2, window: { tmuxPane: '%50' } }];
    const plan = planPaneTidy(
      [own.pane, duplicate.pane, leftover.pane, shell, dead],
      [...own.procs, ...duplicate.procs, ...leftover.procs, { pid: 50, ppid: 1, command: '-zsh' }],
      traps,
      () => undefined,
    );
    expect(plan.map((p) => [p.pane, p.action, p.action === 'stop' ? p.codexPid : undefined])).toEqual([
      ['%19', 'stop', 190],
      ['%3', 'stop', 30],
      ['%7', 'close', undefined],
    ]);
    expect(plan[0]!.why).toContain('duplicate of dune-harbor');
    expect(plan[1]!.why).toContain('not signed on');
  });

  it("never stops a pane whose Codex writes a live trap's thread, whatever its title says", () => {
    const writer = codexPane('%19', 'homebase _ dune-harbor', 190);
    const traps = [{ name: 'dune-harbor', sessionId: T2, window: { tmuxPane: '%50' } }, { name: 'open-valley', sessionId: T1, window: { tmuxPane: '%49' } }];
    const threadOf = (pid: number): ThreadUse | undefined => (pid === 190 ? { threadId: T2, writer: true } : undefined);
    expect(planPaneTidy([writer.pane], writer.procs, traps, threadOf)).toMatchObject([{ pane: '%19', action: 'keep' }]);
    // Reading the thread is not writing it: a duplicate that only has the transcript open still stops.
    const reader = (pid: number): ThreadUse | undefined => (pid === 190 ? { threadId: T2, writer: false } : undefined);
    expect(planPaneTidy([writer.pane], writer.procs, traps, reader)).toMatchObject([{ pane: '%19', action: 'stop', codexPid: 190 }]);
  });

  it('finds Codex under a shell as well as run directly by the pane', () => {
    const pane: PaneInfo = { pane: '%9', dead: false, pid: 90, title: 'ume _ maple-cove' };
    const procs: ProcInfo[] = [{ pid: 90, ppid: 1, command: '-zsh' }, { pid: 91, ppid: 90, command: CODEX }, { pid: 92, ppid: 91, command: HELPER }];
    expect(planPaneTidy([pane], procs, [], () => undefined)).toMatchObject([{ pane: '%9', action: 'stop', codexPid: 91 }]);
  });
});
