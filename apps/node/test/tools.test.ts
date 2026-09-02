import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, ensureLayout, pendingIds } from '@lobstah/core';
import { cancelTool, dispatchTool, sendTool, statusTool } from '../src/tools.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-plugin-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('openclaw plugin tools', () => {
  it('dispatch writes a work-lane descriptor and returns the id', async () => {
    const res = await dispatchTool().execute('t', { repo: 'demo', brief: 'do it', harness: 'claude' });
    const { id } = res.details as { id: string };
    expect(pendingIds('work')).toEqual([id]);
    expect(res.content[0]!.text).toContain(id);
  });

  it('status reconciles a single dispatch and lists active ones', async () => {
    const { id } = (await dispatchTool().execute('t', { repo: 'demo', brief: 'b' })).details as { id: string };
    claimNext('work');
    appendStatus(id, 'work', 'needs-decision', 'pick a color');
    const one = await statusTool().execute('t', { id });
    expect(one.content[0]!.text).toContain('needs-decision');
    const all = await statusTool().execute('t', {});
    expect(all.content[0]!.text).toContain(id);
  });

  it('send queues an inbox record; cancel writes the marker', async () => {
    const { id } = (await dispatchTool().execute('t', { repo: 'demo', brief: 'b' })).details as { id: string };
    claimNext('work');
    await sendTool().execute('t', { id, message: 'also update docs' });
    expect(fs.readdirSync(path.join(home, 'inbox', id)).filter((f) => f.endsWith('.msg'))).toHaveLength(1);
    await cancelTool().execute('t', { id });
    expect(fs.existsSync(path.join(home, 'active', id, 'cancel'))).toBe(true);
  });

  it('unknown dispatch ids are errors, not empty results', async () => {
    await expect(cancelTool().execute('t', { id: 'nope' })).rejects.toThrow(/unknown dispatch/);
  });
});
