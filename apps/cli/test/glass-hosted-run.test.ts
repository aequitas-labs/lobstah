import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { GlassRunCard } from '@lobstah/core';
import { runInputsText, sha256Hex } from '@lobstah/core';
import { openSealedInput } from '../src/run-seal.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW } from './fixtures/glass-snapshots.js';
import { RUN_KEY, glassRun, runCardFleet } from './fixtures/run-card.js';

/**
 * A run card on the hosted glass (ume 2ec9c88b-193, intent hosted-run): the
 * card names its boat, Run needs a phone passkey paired with it, the page
 * never asks for one over a script it doesn't show, and one confirmation
 * opens a 15-minute window the page's own key signs within.
 */

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const hostedRun = (over: Partial<GlassRunCard> = {}) => glassRun('#!/bin/bash\necho hi\n', { inputs: [], boat: 'studio', ...over });

type Sent = { kind: string; payload: Record<string, unknown> };

async function page(run: GlassRunCard, opts: { phones?: number; answer?: (sent: Sent) => { status: number; body: unknown }; fleet?: (f: ReturnType<typeof runCardFleet>) => void } = {}) {
  const fleet = runCardFleet(run);
  opts.fleet?.(fleet);
  fleet.runPasskeys = { count: 0, hosted: opts.phones ?? 1 };
  const sent: Sent[] = [];
  let prompts = 0;
  const g = await loadGlass(GLASS_PAGE, fleet, {
    now: NOW,
    hash: `#decision/${encodeURIComponent(RUN_KEY)}`,
    prepare: (window) => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
      const bytes = (s: string) => new TextEncoder().encode(s).buffer;
      Object.defineProperty(window.navigator, 'credentials', {
        configurable: true,
        value: {
          get: async () => {
            prompts += 1;
            return { rawId: bytes('phone'), response: { clientDataJSON: bytes('{}'), authenticatorData: bytes('a'), signature: bytes('s') } };
          },
        },
      });
    },
    post: (_url, request) => {
      const s = JSON.parse(request.body) as Sent;
      sent.push(s);
      return opts.answer?.(s) ?? { status: 404, body: { ok: false } };
    },
  });
  open.push(g);
  const run_ = async () => {
    (g.$('#doverlay .runbtn') as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) await g.settle();
  };
  return { g, sent, prompts: () => prompts, run: run_, fleet };
}

describe('Run on the hosted glass', () => {
  it('says to pair a phone first, and keeps Run off, when none is paired with the boat', async () => {
    const { g } = await page(hostedRun(), { phones: 0 });
    expect(text(g.$('#doverlay .runhead .badge'))).toBe('runs on studio');
    expect((g.$('#doverlay .runbtn') as HTMLButtonElement).disabled).toBe(true);
    expect(text(g.$('#doverlay .runfoot .dim'))).toBe('Pair this phone first: run lobstah run passkey add --hosted on the Mac.');
  });

  it('keeps an interactive card, and one with a secret input, on the Mac', async () => {
    const { g } = await page(hostedRun({ interactive: true }));
    expect((g.$('#doverlay .runbtn') as HTMLButtonElement).disabled).toBe(true);
    expect(text(g.$('#doverlay .runfoot .dim'))).toBe('Interactive cards run from the Mac.');
    // A boat that publishes no seal key takes no secret from the hosted glass.
    const secret = await page(hostedRun({ inputs: [{ name: 'TOKEN', secret: true }] }));
    expect((secret.g.$('#doverlay .runbtn') as HTMLButtonElement).disabled).toBe(true);
    expect(text(secret.g.$('#doverlay .runfoot .dim'))).toBe('Secret inputs are typed on the Mac for now.');
  });

  it("never asks for the passkey when the boat's script hash isn't the one this page shows", async () => {
    const run = hostedRun();
    const h = await page(run, { answer: (s) => (s.kind === 'run-challenge' ? { status: 200, body: { ok: true, challenge: 'Y2hhbGxlbmdl', rpId: 'glass.test', credentialIds: [], sha256: 'f'.repeat(64) } } : { status: 404, body: { ok: false } }) });
    await h.run();
    expect(h.prompts()).toBe(0);
    expect(h.sent.map((s) => s.kind)).not.toContain('run');
    expect(text(h.g.$('#doverlay .runcard .bad'))).toBe("The script this page shows isn't the card's. Reload the page.");
  });

  it('opens a 15-minute window on a passkey Run, then signs the next Run with the page key, with no passkey', async () => {
    const run = hostedRun();
    const until = NOW + 15 * 60_000;
    const answer = (s: Sent) => {
      if (s.kind === 'run-challenge') return { status: 200, body: s.payload.window ? { ok: true, challenge: 'd2luZG93', window: 'w1', windowUntil: until, sha256: run.scriptSha256 } : { ok: true, challenge: 'cGFzc2tleQ', rpId: 'glass.test', credentialIds: [], sha256: run.scriptSha256 } };
      if (s.kind === 'run') return { status: 202, body: { ok: true, running: true, key: RUN_KEY, ...(s.payload.window ? {} : { window: 'w1', windowUntil: until }) } };
      if (s.kind === 'run-output') return { status: 200, body: { ok: true, id: 'a1', state: 'succeeded', text: 'hi\n', next: 3, result: { exitCode: 0, timedOut: false, durationMs: 5, outputBytes: 3, scrubbed: 0 } } };
      return { status: 404, body: { ok: false } };
    };
    const h = await page(run, { answer });
    await h.run();
    expect(h.prompts()).toBe(1);
    const first = h.sent.find((s) => s.kind === 'run')!.payload;
    // The page's window key: its public half, SPKI, base64url; never its private half.
    expect(typeof first.windowKey).toBe('string');
    expect(String(first.windowKey)).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(text(h.g.$('#doverlay .runfoot .dim'))).toBe('Confirmed for 15 more minutes.');
    await h.run();
    expect(h.prompts()).toBe(1);
    const runs = h.sent.filter((s) => s.kind === 'run');
    expect(runs).toHaveLength(2);
    expect(h.sent.filter((s) => s.kind === 'run-challenge')[1]!.payload.window).toBe('w1');
    expect(runs[1]!.payload).toMatchObject({ key: RUN_KEY, challenge: 'd2luZG93', window: 'w1' });
    expect(String(runs[1]!.payload.windowSignature)).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(runs[1]!.payload.credentialId).toBeUndefined();
  });
});

describe('a finished run card', () => {
  it('still goes to the previous and next decision, by button and by arrow key, after its run answered it', async () => {
    const run = hostedRun();
    const decision = (key: string, title: string, at: string) => ({
      attention: { kind: 'decision' as const, key, stateHash: key, id: key, lane: 'work' as const, verb: 'decision', ageSecs: 60, at, standingSince: at, note: title },
      decision: { key, title, detail: '', options: ['Yes', 'No'], attachments: [], askedBy: 'helm', askedAt: at, stateHash: key },
    });
    // One decision asked before the run card, one after.
    const before = decision('decision:before', 'Asked before', new Date(NOW - 120_000).toISOString());
    const after = decision('decision:after', 'Asked after', new Date(NOW - 30_000).toISOString());
    const answer = (s: Sent) => {
      if (s.kind === 'run-challenge') return { status: 200, body: { ok: true, challenge: 'cGFzc2tleQ', rpId: 'glass.test', credentialIds: [], sha256: run.scriptSha256 } };
      if (s.kind === 'run') return { status: 202, body: { ok: true, running: true, key: RUN_KEY } };
      if (s.kind === 'run-output') return { status: 200, body: { ok: true, id: 'a1', state: 'succeeded', text: 'hi\n', next: 3, result: { exitCode: 0, timedOut: false, durationMs: 5, outputBytes: 3, scrubbed: 0 } } };
      return { status: 404, body: { ok: false } };
    };
    const h = await page(run, {
      answer,
      fleet: (f) => {
        f.attention.push(before.attention, after.attention);
        f.decisions.push(before.decision, after.decision);
      },
    });
    await h.run();
    expect(text(h.g.$('#doverlay .runstate'))).toContain('Succeeded');
    // The run answered the card: the next snapshot no longer lists it, and the card stays on screen with its result.
    h.fleet.attention = h.fleet.attention.filter((a) => a.key !== RUN_KEY);
    h.fleet.decisions = h.fleet.decisions.filter((d) => d.key !== RUN_KEY);
    h.g.serve(h.fleet);
    await h.g.poll();
    expect(text(h.g.$('#doverlay .runstate'))).toContain('Succeeded');
    expect((h.g.$('#doverlay .dprev') as HTMLButtonElement).disabled).toBe(false);
    expect((h.g.$('#doverlay .dnext') as HTMLButtonElement).disabled).toBe(false);
    (h.g.$('#doverlay .dnext') as HTMLButtonElement).click();
    await h.g.settle();
    expect(h.g.$('#doverlay .dmodal')!.getAttribute('data-decision')).toBe('decision:after');
    // The run card is no longer listed, so ← from the next decision goes to the one asked before it.
    h.g.document.dispatchEvent(new h.g.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await h.g.settle();
    expect(h.g.$('#doverlay .dmodal')!.getAttribute('data-decision')).toBe('decision:before');
  });

  it('goes back by arrow key too, from the finished card', async () => {
    const run = hostedRun();
    const at = new Date(NOW - 120_000).toISOString();
    const answer = (s: Sent) => {
      if (s.kind === 'run-challenge') return { status: 200, body: { ok: true, challenge: 'cGFzc2tleQ', rpId: 'glass.test', credentialIds: [], sha256: run.scriptSha256 } };
      if (s.kind === 'run') return { status: 202, body: { ok: true, running: true, key: RUN_KEY } };
      if (s.kind === 'run-output') return { status: 200, body: { ok: true, id: 'a1', state: 'failed', text: '', next: 0, result: { exitCode: 2, timedOut: false, durationMs: 5, outputBytes: 0, scrubbed: 0 } } };
      return { status: 404, body: { ok: false } };
    };
    const h = await page(run, {
      answer,
      fleet: (f) => {
        f.attention.push({ kind: 'decision', key: 'decision:before', stateHash: 'b', id: 'b', lane: 'work', verb: 'decision', ageSecs: 60, at, standingSince: at, note: 'Asked before' });
        f.decisions.push({ key: 'decision:before', title: 'Asked before', detail: '', options: ['Yes'], attachments: [], askedBy: 'helm', askedAt: at, stateHash: 'b' });
      },
    });
    await h.run();
    h.fleet.attention = h.fleet.attention.filter((a) => a.key !== RUN_KEY);
    h.fleet.decisions = h.fleet.decisions.filter((d) => d.key !== RUN_KEY);
    h.g.serve(h.fleet);
    await h.g.poll();
    expect(text(h.g.$('#doverlay .runstate'))).toContain('Failed');
    expect((h.g.$('#doverlay .dnext') as HTMLButtonElement).disabled).toBe(true);
    h.g.document.dispatchEvent(new h.g.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await h.g.settle();
    expect(h.g.$('#doverlay .dmodal')!.getAttribute('data-decision')).toBe('decision:before');
  });
});

describe('a secret input on the hosted glass', () => {
  it("is sealed to the boat's key before it leaves the page, and the run challenge binds what was sent", async () => {
    const boat = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sealKey = (boat.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
    const run = hostedRun({ inputs: [{ name: 'TOKEN', secret: true }, { name: 'ENV', secret: false }], sealKey });
    const answer = (s: Sent) => {
      if (s.kind === 'run-challenge') return { status: 200, body: { ok: true, challenge: 'cGFzc2tleQ', rpId: 'glass.test', credentialIds: [], sha256: run.scriptSha256 } };
      if (s.kind === 'run') return { status: 202, body: { ok: true, running: true, key: RUN_KEY } };
      if (s.kind === 'run-output') return { status: 200, body: { ok: true, id: 'a1', state: 'succeeded', text: '', next: 0, result: { exitCode: 0, timedOut: false, durationMs: 1, outputBytes: 0, scrubbed: 0 } } };
      return { status: 404, body: { ok: false } };
    };
    const h = await page(run, { answer });
    const type = async (name: string, value: string) => {
      const input = h.g.$(`#doverlay .runinput input[aria-label="${name}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new h.g.window.Event('input', { bubbles: true }));
      await h.g.settle();
    };
    await type('TOKEN', 'hunter2');
    await type('ENV', 'staging');
    expect((h.g.$('#doverlay .runbtn') as HTMLButtonElement).disabled).toBe(false);
    await h.run();
    const sent = h.sent.find((x) => x.kind === 'run')!.payload.inputs as Record<string, unknown>;
    // The secret leaves the page sealed; a text input goes plain.
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect(sent.ENV).toBe('staging');
    expect(Object.keys(sent.TOKEN as object).sort()).toEqual(['ct', 'epk', 'iv']);
    // Only the boat's key opens it.
    expect(openSealedInput(sent.TOKEN, boat.privateKey)).toBe('hunter2');
    // The challenge bound exactly what was sent.
    const challenge = h.sent.find((x) => x.kind === 'run-challenge')!.payload;
    expect(challenge.inputsSha256).toBe(sha256Hex(runInputsText(sent as never)));
  });
});

describe('Stop and Dismiss on the hosted glass', () => {
  it('offers Stop while a run goes and Dismiss and Run again after, and sends them to the boat', async () => {
    const run = hostedRun({
      latest: { id: 'a1', key: RUN_KEY, scriptSha256: hostedRun().scriptSha256, state: 'running', startedAt: new Date(NOW - 1000).toISOString() },
    });
    // A failed output read ends the page's polling, as on the Mac; Stop stays.
    const h = await page(run, {
      answer: (s) => (s.kind === 'run-stop' ? { status: 202, body: { ok: true } } : { status: 500, body: { ok: false, reason: 'Output unavailable' } }),
    });
    const stop = h.g.$$('#doverlay .runfoot button').find((b) => text(b) === 'Stop') as HTMLButtonElement;
    expect(stop).toBeTruthy();
    stop.click();
    await h.g.settle();
    expect(h.sent.map((s) => s.kind)).toContain('run-stop');

    const done = hostedRun({
      latest: { id: 'a2', key: RUN_KEY, scriptSha256: hostedRun().scriptSha256, state: 'succeeded', startedAt: new Date(NOW - 2000).toISOString(), finishedAt: new Date(NOW - 1000).toISOString(), result: { exitCode: 0, timedOut: false, durationMs: 1000, outputBytes: 0, scrubbed: 0 } },
    });
    const d = await page(done, { answer: (s) => (s.kind === 'run-output' ? { status: 200, body: { ok: true, id: 'a2', state: 'succeeded', text: '', next: 0, result: { exitCode: 0, timedOut: false, durationMs: 1000, outputBytes: 0, scrubbed: 0 } } } : { status: 200, body: { ok: true } }) });
    expect(text(d.g.$('#doverlay .runbtn'))).toBe('Run again');
    const dismiss = d.g.$$('#doverlay .runfoot button').find((b) => text(b) === 'Dismiss') as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    dismiss.click();
    await d.g.settle();
    expect(d.sent.map((s) => s.kind)).toContain('run-dismiss');
  });
});
