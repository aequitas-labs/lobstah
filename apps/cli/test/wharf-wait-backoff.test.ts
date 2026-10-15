import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_WAIT, IdleWait, brokerRequest, type BrokerAgent } from '@lobstah/core';
import { waitBrokerAgent } from '../src/wharf-soak.js';
import { removeTempDir } from '../../../test/temp-dir.js';

vi.mock('@lobstah/core', async (original) => ({ ...await original<typeof import('@lobstah/core')>(), brokerRequest: vi.fn() }));
let home: string;
const agent: BrokerAgent = { grounds: 'away', repo: 'r', trap: 'kind-crab', session: 'hosted-trap', capability: 'test-only', worktree: '/unused' };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-hosted-wait-'));
  process.env.LOBSTAH_HOME = home;
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.mocked(brokerRequest).mockReset().mockResolvedValue({ claim: null });
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('the hosted idle trap persists configurable repeats, doubling and cap', async () => {
  fs.writeFileSync(path.join(home, 'config.toml'), '[wait]\nbaseTimeoutSecs = 1\nbaseRepeats = 3\nmaxTimeoutSecs = 4\n');
  for (const seconds of [1, 1, 1, 2, 4, 4]) {
    const result = waitBrokerAgent(agent);
    await vi.advanceTimersByTimeAsync(seconds * 1000);
    expect(await result).toEqual({ claim: null });
  }
});

it('a capped wait still polls normally, delivers its event and resets to base', async () => {
  for (let i = 0; i < 7; i++) new IdleWait(agent.session, DEFAULT_WAIT, undefined, 0).timedOut(14_400_000);
  expect(new IdleWait(agent.session, DEFAULT_WAIT).timeoutSecs).toBe(14400);
  const message = { claim: null, dispatch: 'job', messages: [{ id: 'answer', text: 'next step', received: false }] };
  vi.mocked(brokerRequest).mockResolvedValueOnce({ claim: null }).mockResolvedValue(message);
  const result = waitBrokerAgent(agent);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toEqual(message);
  expect(brokerRequest).toHaveBeenCalledTimes(2);
  expect(new IdleWait(agent.session, DEFAULT_WAIT).timeoutSecs).toBe(900);
});
