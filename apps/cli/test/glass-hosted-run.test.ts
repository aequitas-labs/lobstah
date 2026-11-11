import { afterEach, describe, expect, it } from 'vitest';
import type { GlassRunCard } from '@lobstah/core';
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

async function page(run: GlassRunCard, opts: { phones?: number; answer?: (sent: Sent) => { status: number; body: unknown } } = {}) {
  const fleet = runCardFleet(run);
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
  return { g, sent, prompts: () => prompts, run: run_ };
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
