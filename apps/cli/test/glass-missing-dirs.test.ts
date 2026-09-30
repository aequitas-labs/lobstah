import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { activeIds, enqueue, ensureLayout, laneDirs, pendingIds } from '@lobstah/core';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-missing-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('glass over missing folders', () => {
  it('reads a missing lane folder as empty', () => {
    expect(fs.existsSync(path.join(home, 'chores'))).toBe(false);
    expect(pendingIds('chore')).toEqual([]);
    expect(activeIds('chore')).toEqual([]);
    expect(pendingIds('work')).toEqual([]);
    expect(activeIds('work')).toEqual([]);
  });

  it('builds a snapshot over a home with no chores folder', () => {
    ensureLayout();
    enqueue({ id: '44444444-4444-4444-4444-444444444444', repo: 'web', brief: 'work lane item' }, 'work');
    fs.rmSync(path.join(home, 'chores'), { recursive: true, force: true });
    expect(fs.existsSync(laneDirs('chore').queue)).toBe(false);
    const snap = buildGlassSnapshot();
    expect(snap.dispatches.filter((d) => d.lane === 'chore')).toEqual([]);
    expect(snap.dispatches.map((d) => d.id)).toEqual(['44444444-4444-4444-4444-444444444444']);
  });

  it('builds a snapshot over an empty home', () => {
    const snap = buildGlassSnapshot();
    expect(snap.dispatches).toEqual([]);
  });

  it('answers 500 when the snapshot throws, logs once, and keeps serving', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const server = serveGlass(0, {
      snapshot: () => {
        if (fail) throw new Error("ENOENT: no such file or directory, scandir '/x/chores/queue'");
        return buildGlassSnapshot();
      },
    });
    try {
      await new Promise((r) => server.once('listening', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${base}/data`);
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: expect.any(String) });
      }
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain('ENOENT');
      expect((await fetch(`${base}/`)).status).toBe(200);
      fail = false;
      const ok = await fetch(`${base}/data`);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { dispatches: unknown[] }).dispatches).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
