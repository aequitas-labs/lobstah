import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, loadConfig } from '@lobstah/core';
import { loadPickupConfig, pickupPlan } from '@lobstah/pick';
import { pickRunning, setupReviews, writeReviewMode } from '../src/reviews-setup.js';
import { runDoctor } from '../src/doctor.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-setup-'));
  process.env.LOBSTAH_HOME = home;
  process.env.LOBSTAH_TEST_REVIEW_TOKEN = 'fixture';
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  delete process.env.LOBSTAH_TEST_REVIEW_TOKEN;
  removeTempDir(home);
});
const write = (s: string) => fs.writeFileSync(path.join(home, 'config.toml'), s);
const auth = '[reviews]\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\n';

it('writes a self-contained notify setup and installs pick after showing only enabled loops', async () => {
  write(auth);
  const install = vi.fn(() => ({ loaded: true }));
  const logs: string[] = [];
  await setupReviews(undefined, { login: () => 'chris', install, log: (s) => logs.push(s) });
  expect(install).toHaveBeenCalledOnce();
  expect(loadConfig().reviews).toMatchObject({ enabled: true, mode: 'notify', identity: 'chris', work: 'off', post: 'draft' });
  expect(loadConfig().attentionKinds).toContain('review');
  expect(loadPickupConfig()).toMatchObject({ github: [], reviews: { identity: 'chris' } });
  expect(logs.join('\n')).toContain('review requests: chris, mode notify');
  expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).not.toContain('[pickup.github]');
});

it('the minimal setup writes gh auth token as the token source without a pickup table', () => {
  writeReviewMode('notify', 'chris');
  expect(loadConfig().reviews).toMatchObject({ identity: 'chris', tokenCommand: 'gh auth token', repos: 'any', mode: 'notify' });
});

it('new setup credentials stay self-contained even beside a legacy pickup block', () => {
  write('[pickup.github]\nidentity = "legacy-bot"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\nissues = false\nfeedback = false\n');
  writeReviewMode('notify', 'chris');
  expect(loadConfig().reviews).toMatchObject({ identity: 'chris', tokenCommand: 'gh auth token' });
  expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain('identity = "legacy-bot"');
});

it('mode changes preserve unrelated config, comments, token refs, and multiline attention lists', () => {
  write(
    '# personal config\nattentionKinds = [\n "question",\n "pr:ready",\n]\n[repos.web]\npath = "/w" # keep me\n' +
      auth +
      '# existing auth\n',
  );
  for (const mode of ['on-demand', 'auto', 'notify']) {
    writeReviewMode(mode);
    expect(loadConfig().reviews.mode).toBe(mode);
    expect(loadConfig().reviews.tokenEnv).toBe('LOBSTAH_TEST_REVIEW_TOKEN');
  }
  const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  expect(text).toContain('# personal config');
  expect(text).toContain('path = "/w" # keep me');
  expect(text).toContain('# existing auth');
  expect(loadConfig().attentionKinds).toEqual(['question', 'pr:ready']);
  const before = text;
  expect(() => writeReviewMode('post')).toThrow('notify, on-demand, or auto');
  expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(before);
});

it('doctor shows reviews identity, mode and pick liveness without opting a repo into pickup', async () => {
  write(auth + 'enabled = true\nmode = "notify"\n');
  let rows = await runDoctor();
  expect(rows.find((r) => r.check === 'reviews')).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('chris; mode notify; pick not running'),
  });
  fs.writeFileSync(path.join(home, 'pick.json'), JSON.stringify({ pid: process.pid, heartbeat: new Date().toISOString(), pollSecs: 45 }));
  expect(pickRunning()).toBe(true);
  rows = await runDoctor();
  expect(rows.find((r) => r.check === 'reviews')).toMatchObject({ status: 'ok', detail: expect.stringContaining('pick running') });
});

it('the pre-install loop plan warns about legacy defaults and lists per-repo switches', () => {
  write(
    '[repos.web]\npath = "/w"\npickup = true\norigin = "https://github.com/acme/web"\n[pickup.github]\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\n',
  );
  expect(pickupPlan().join('\n')).toContain('web: issues ON, PR feedback ON');
  expect(pickupPlan().join('\n')).toContain('WARNING: legacy');
  fs.appendFileSync(path.join(home, 'config.toml'), 'issues = true\nfeedback = false\n');
  expect(pickupPlan().join('\n')).toContain('web: issues ON, PR feedback off');
});

it('reviews setup does not install pick while unrelated legacy pickup loops would run', async () => {
  write(auth + '[pickup.github]\nidentity = "chris"\ntokenEnv = "LOBSTAH_TEST_REVIEW_TOKEN"\nrepo = "acme/web"\nkey = "web"\n');
  const install = vi.fn();
  await expect(setupReviews('chris', { install, log: () => {} })).rejects.toThrow('pick was not installed');
  expect(install).not.toHaveBeenCalled();
  expect(loadConfig().reviews.mode).toBe('notify');
});
