import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, decisionDir, enqueue, ensureLayout, executorPath, listDecisions, readStatusLog, sha256Hex } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW } from './fixtures/glass-snapshots.js';
import { RUN_KEY, glassRun, runCardFleet } from './fixtures/run-card.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Run cards, PR 1 (ume 3ef69c1d-026, intent run-card-post): `man ask --run`
 * posts a card that carries its script whole with the stored copy's hash, a
 * trap proposes a script with `report needs-decision --run`, and the glass
 * shows the script, its flagged characters and what runs it, with Run
 * disabled until a passkey is set up.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const D = 'aaaaaaaa-1111-4000-8000-0000000000d1';

let home: string;
let src: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-cards-cli-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
  src = path.join(home, 'src');
  fs.mkdirSync(src);
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000 });
}
/** What the CLI said, on either stream. */
const said = (res: ReturnType<typeof lobstah>): string => `${res.stdout}${res.stderr}`;
const write = (name: string, body: string) => {
  const file = path.join(src, name);
  fs.writeFileSync(file, body);
  return file;
};

describe('man ask --run', () => {
  it('posts a run card whose snapshot carries the script text and the hash of its stored copy', () => {
    const body = '#!/bin/bash\nIFS= read -r CRON_SECRET\necho wiped\n';
    const res = lobstah('man', 'ask', '--title', 'Wipe test mail', '--run', write('wipe.sh', body), '--input', 'CRON_SECRET', '--cwd', src, '--timeout', '2m');
    expect(res.status, res.stderr).toBe(0);
    const [card] = listDecisions();
    expect(card!.options).toEqual(['Decline']);
    expect(fs.readFileSync(path.join(decisionDir(card!.key)!, 'run', 'script'), 'utf8')).toBe(body);
    const shown = buildGlassSnapshot().decisions.find((d) => d.key === card!.key)!;
    expect(shown.run).toMatchObject({
      script: body,
      scriptSha256: sha256Hex(body),
      inputs: [{ name: 'CRON_SECRET', secret: true }],
      cwd: src,
      timeoutSecs: 120,
      output: 'scrubbed',
      interpreter: '/bin/bash',
    });
    expect(shown.run!.altered).toBeUndefined();
  });

  it('refuses a script over 16 KB and stores no card', () => {
    const res = lobstah('man', 'ask', '--title', 'Too big', '--run', write('big.sh', '#'.repeat(16 * 1024 + 1)), '--cwd', src);
    expect(res.status).not.toBe(0);
    expect(said(res)).toContain('exceeds 16384 bytes');
    expect(listDecisions()).toEqual([]);
  });

  it('refuses run flags without --run, and --option with it', () => {
    expect(said(lobstah('man', 'ask', '--title', 'X', '--input', 'A'))).toContain('--input goes with --run');
    expect(said(lobstah('man', 'ask', '--title', 'X', '--run', write('x.sh', 'true\n'), '--option', 'Yes'))).toContain('--option does not go with --run');
    expect(listDecisions()).toEqual([]);
  });

  it('shows a card whose stored script was changed as altered', () => {
    expect(lobstah('man', 'ask', '--title', 'Hi', '--run', write('hi.sh', 'echo hi\n'), '--cwd', src).status).toBe(0);
    const [card] = listDecisions();
    fs.writeFileSync(path.join(decisionDir(card!.key)!, 'run', 'script'), 'echo pwned\n');
    expect(buildGlassSnapshot().decisions[0]!.run!.altered).toBe(true);
  });
});

describe('report needs-decision --run', () => {
  it("stores a trap's script as a proposal for the helm, names it in the note, and posts no card", () => {
    enqueue({ id: D, repo: 'web', brief: 'b' }, 'work');
    claimNext('work');
    appendStatus(D, 'work', 'working', 'on it');
    const body = 'echo proposed\n';
    const res = lobstah('report', D, 'needs-decision', 'needs the cron secret', '--run', write('p.sh', body));
    expect(res.status, res.stderr).toBe(0);
    const note = readStatusLog(D, 'work').at(-1)!.note!;
    expect(note).toContain(`run proposal ${sha256Hex(body).slice(0, 12)}`);
    expect(note).toContain(`lobstah man ask ${D}`);
    expect(listDecisions()).toEqual([]);
    expect(said(lobstah('report', D, 'working', 'x', '--run', write('q.sh', body)))).toContain('--run goes with needs-decision');
  });
});

describe('a run card in the glass', () => {
  let open: GlassDom[] = [];
  afterEach(async () => {
    await Promise.all(open.map((g) => g.close()));
    open = [];
  });
  const modal = async (run = glassRun()) => {
    const g = await loadGlass(GLASS_PAGE, runCardFleet(run), { now: NOW, hash: `#decision/${encodeURIComponent(RUN_KEY)}` });
    open.push(g);
    return g;
  };

  it('shows the whole script, its hash, what runs it and each input, with Run disabled until a passkey is set up', async () => {
    const g = await modal();
    const card = g.$('#doverlay .runcard')!;
    expect(card.querySelector('.runscript')!.textContent).toBe(glassRun().script);
    expect(card.querySelector('.runsha')!.textContent).toBe(glassRun().scriptSha256);
    expect(card.textContent).toContain('/bin/bash');
    expect(card.textContent).toContain('/Users/me/base/homebase');
    expect(card.textContent).toContain('time limit 5m');
    expect(card.textContent).toContain('the agent sees the exit code and output, with secrets removed');
    const input = card.querySelector('.runinput input') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('password');
    const run = card.querySelector('.runbtn') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(card.textContent).toContain('Set up a passkey in Settings');
    expect(g.$$('#doverlay .dopt').map((b) => b.textContent?.trim())).toEqual(['1Decline']);
    // A run card also takes a reply, sent with Send; Decline sends at once.
    expect(g.$('#doverlay .ddock textarea')).toBeTruthy();
    expect(g.$('#doverlay .ddock .dsend')).toBeTruthy();
  });

  it('marks and names a zero-width or bidi character by its code point', async () => {
    const g = await modal(glassRun('echo safe‮ hs.dab\nrm​ -rf x\n'));
    const marks = g.$$('#doverlay .runwarn').map((m) => m.getAttribute('title'));
    expect(marks).toEqual(['U+202E RIGHT-TO-LEFT OVERRIDE', 'U+200B ZERO WIDTH SPACE']);
    const list = g.$('#doverlay .runwarnings')!.textContent!;
    expect(list).toContain('line 1, column 10: U+202E RIGHT-TO-LEFT OVERRIDE');
    expect(list).toContain('line 2, column 3: U+200B ZERO WIDTH SPACE');
  });

  it('sends the 127.0.0.1 page to localhost to run, once a passkey is set up', async () => {
    const d = runCardFleet();
    d.runPasskeys = { count: 1 };
    const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: `#decision/${encodeURIComponent(RUN_KEY)}` });
    open.push(g);
    const link = g.$('#doverlay a.runbtn')!;
    expect(link.textContent).toBe('Run from localhost');
    expect(link.getAttribute('href')).toBe(`http://localhost:7777/#decision/${encodeURIComponent(RUN_KEY)}`);
    expect((g.$('#doverlay .runinput input') as HTMLInputElement).disabled).toBe(true);
  });

  it('tells an interactive card apart, so Chris knows it will ask him for lines', async () => {
    const g = await modal(glassRun(undefined, { interactive: true, output: 'exit' }));
    expect(g.$('#doverlay .runmeta')!.textContent).toContain('interactive: answer its prompts here');
    expect(g.$('#doverlay .runmeta')!.textContent).toContain('the exit code only');
  });

  it('shows the output as a terminal did: colors as spans, the spinner and the answered prompt collapsed, no escape codes', async () => {
    const run = glassRun(undefined, { inputs: [], latest: {
      id: '22222222-2222-4222-8222-222222222222', key: RUN_KEY, scriptSha256: glassRun().scriptSha256,
      state: 'succeeded', startedAt: new Date(NOW - 2000).toISOString(), finishedAt: new Date(NOW - 1000).toISOString(),
      result: { exitCode: 0, timedOut: false, durationMs: 1000, outputBytes: 99, scrubbed: 0 },
    } });
    const raw = '\x1b[31m✘ \x1b[41;97mERROR\x1b[0m bad\r\n\x1b[36m?\x1b[39m Apply? (Y/n)\x1b[2K\x1b[1G\x1b[32m✔\x1b[39m Apply? … yes\r\n\x1b[1G\x1b[0K⠙\x1b[1G\x1b[0K== Deploying\r\n';
    const g = await loadGlass(GLASS_PAGE, runCardFleet(run), {
      now: NOW, host: 'localhost:7777', hash: `#decision/${encodeURIComponent(RUN_KEY)}`,
      post: (_url, request) => {
        const { kind } = JSON.parse(request.body) as { kind: string };
        if (kind === 'run-output') return { status: 200, body: { ok: true, ...run.latest, text: raw, next: raw.length } };
        return { status: 404, body: { ok: false } };
      },
    });
    open.push(g);
    const log = g.$('#doverlay .runlog')!;
    expect(log.textContent).toBe('✘ ERROR bad\n✔ Apply? … yes\n== Deploying');
    const spans = [...log.querySelectorAll('span')].map((s) => [s.textContent, s.getAttribute('style')]);
    expect(spans).toContainEqual(['✘ ', 'color: var(--ansi-1);']);
    expect(spans).toContainEqual(['ERROR', 'color: var(--ansi-15); background: var(--ansi-1);']);
    expect(spans).toContainEqual(['✔', 'color: var(--ansi-2);']);
  });

  it('reloads a failed run with its output, retry and Dismiss controls', async () => {
    const run = glassRun(undefined, { inputs: [], latest: {
      id: '11111111-1111-4111-8111-111111111111', key: RUN_KEY, scriptSha256: glassRun().scriptSha256,
      state: 'failed', startedAt: new Date(NOW - 2000).toISOString(), finishedAt: new Date(NOW - 1000).toISOString(),
      result: { exitCode: 3, timedOut: false, durationMs: 1000, outputBytes: 12, scrubbed: 0 },
    } });
    const fleet = runCardFleet(run);
    fleet.runPasskeys = { count: 1 };
    const requests: string[] = [];
    const g = await loadGlass(GLASS_PAGE, fleet, {
      now: NOW, host: 'localhost:7777', hash: `#decision/${encodeURIComponent(RUN_KEY)}`,
      prepare: (window) => {
        Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
        Object.defineProperty(window.navigator, 'credentials', { value: {}, configurable: true });
      },
      post: (_url, request) => {
        const { kind } = JSON.parse(request.body) as { kind: string };
        requests.push(kind);
        if (kind === 'run-output') return { status: 200, body: { ok: true, ...run.latest, text: 'command failed', next: 14 } };
        if (kind === 'run-dismiss') return { status: 200, body: { ok: true } };
        return { status: 404, body: { ok: false } };
      },
    });
    open.push(g);
    expect(g.$('#doverlay .runstate .runicon.run-failed')?.getAttribute('aria-label')).toMatch(/^Failed · exit 3\b/);
    expect(g.$('#doverlay .runlog')?.textContent).toContain('command failed');
    expect(g.$('#doverlay .runbtn')?.textContent).toBe('Run again');
    expect(g.$$('#doverlay .dopt')).toHaveLength(0);
    const dismiss = g.$$('#doverlay .runfoot button').find((button) => button.textContent === 'Dismiss') as HTMLButtonElement;
    dismiss.click();
    await g.settle();
    expect(requests).toContain('run-dismiss');
  });

  it.each([false, true])('keeps Stop available after an output failure for a running card (read-only %s)', async (readOnly) => {
    const run = glassRun(undefined, { inputs: [], latest: {
      id: '11111111-1111-4111-8111-111111111111', key: RUN_KEY, scriptSha256: glassRun().scriptSha256,
      state: 'running', startedAt: new Date(NOW - 2000).toISOString(),
    } });
    const requests: string[] = [];
    const fleet = runCardFleet(run);
    fleet.decisions[0]!.readOnly = readOnly;
    const g = await loadGlass(GLASS_PAGE, fleet, {
      now: NOW, hash: `#decision/${encodeURIComponent(RUN_KEY)}`,
      post: (_url, request) => {
        const { kind } = JSON.parse(request.body) as { kind: string };
        requests.push(kind);
        if (kind === 'run-stop') return { status: 202, body: { ok: true } };
        return { status: 500, body: { ok: false, reason: 'Output unavailable' } };
      },
    });
    open.push(g);
    const stop = g.$$('#doverlay .runfoot button').find((button) => button.textContent === 'Stop') as HTMLButtonElement;
    expect(stop).toBeDefined();
    expect(g.$('#doverlay .runstate .runicon.run-running')?.getAttribute('aria-label')).toMatch(/^Running · started /);
    expect(g.$('#doverlay .runbtn')).toBeNull();
    stop.click();
    await g.settle();
    expect(requests).toContain('run-stop');
  });

  it("says a card whose stored copy changed won't run", async () => {
    const g = await modal(glassRun(undefined, { altered: true }));
    expect(g.$('#doverlay .runcard')!.textContent).toContain("This script changed after it was proposed, so it can't run.");
  });

  it('wraps a long path, hash or name at phone width, and lets each row of the card shrink', () => {
    // happy-dom lays nothing out, so this reads the stylesheet; the PR's 375px screenshots show the result.
    const css = fs.readFileSync(new URL('../../../packages/glass-ui/ui/glass.css', import.meta.url), 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(`\n${sel} {`);
      expect(at, sel).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.runcard')).toContain('overflow-wrap: anywhere;');
    const shrinks = css.slice(css.indexOf('\n.runcard > *,'), css.indexOf('}', css.indexOf('\n.runcard > *,')));
    for (const row of ['.runcard', '.runhead', '.runmeta', '.runinput', '.runfoot', '.runout']) expect(shrinks).toContain(`${row} > *`);
    expect(shrinks).toContain('min-width: 0;');
    expect(rule('.runcard .badge')).toContain('white-space: normal;');
  });
});
