import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stringify } from 'smol-toml';
import { DeploymentWatchType, FixtureDeploymentProvider, deploymentFixtureFiles } from '@lobstah/watch-types/deployment';
import { WatchRegistry, disposeWatchPlugins } from '@lobstah/watch-types';
import type { DeploymentReference, DeploymentState, DeploymentTransition, DeploymentOptions } from '@lobstah/watch-types/deployment';
import type { WatchSnapshot } from '@lobstah/watch-types';
import {
  WatchRuntime,
  WatchJournal,
  WatchActionRunner,
  WatchSubscriptionManager,
  builtinWatchRegistry,
  ensureLayout,
  pendingWatchEvents,
  registerInstalledWatch,
} from '../src/index.js';
import { deliverDispatchOwned } from '../../../apps/pick/src/loops/watch.js';
import { appendStatus, laneDirs } from '../src/index.js';
import { buildGlassSnapshot } from '../../../apps/cli/src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
let streams: WatchSubscriptionManager | undefined;
const program = fileURLToPath(new URL('../../watch-types/dist/deployment/plugin.js', import.meta.url));
const key = 'deployment:production/run-7',
  logUrl = 'https://deploy.example.test/logs/run-7';
const at = '2026-11-19T00:00:00.000Z';
const transition = (sequence: number, phase: DeploymentState['phase'], terminal = false): DeploymentTransition => ({
  environment: 'production',
  deploymentId: 'run-7',
  at,
  sequence,
  phase,
  logUrl,
  terminal,
});
const historyFile = () => path.join(home, 'history.json');
const history = (events: DeploymentTransition[]) => fs.writeFileSync(historyFile(), JSON.stringify(events));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-deployment-extension-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  history([]);
});
afterEach(async () => {
  await streams?.dispose();
  streams = undefined;
  await disposeWatchPlugins();
  removeTempDir(home);
});

function configureProcess(): void {
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    stringify({
      schemaVersion: 2,
      watchTypes: {
        deployment: {
          module: 'process',
          command: [process.execPath, program],
          version: '1.0.0',
          allowCapabilities: ['poll', 'subscribe', 'actions'],
          fixturePath: historyFile(),
        },
      },
    }),
  );
}
function localRuntime(): { host: WatchRuntime; provider: FixtureDeploymentProvider } {
  const provider = new FixtureDeploymentProvider(),
    registry = new WatchRegistry();
  registry.register(new DeploymentWatchType(provider));
  return { host: new WatchRuntime(registry), provider };
}

it('delivers one owner inbox pointer and the source log link through unmodified glass presentation', () => {
  configureProcess();
  registerInstalledWatch(key, { kind: 'helm', grounds: 'home' });
  const host = new WatchRuntime(builtinWatchRegistry());
  history([transition(1, 'failed')]);
  host.checkSync(key, { everySecs: 0 });
  host.checkSync(key, { everySecs: 0 });
  expect(pendingWatchEvents(false, 'man')).toHaveLength(1);
  expect(pendingWatchEvents(false, 'man')[0]!.events).toHaveLength(1);
  const glass = buildGlassSnapshot({ local: true });
  const failure = glass.attention.find((entry) => entry.kind === 'deployment:failed');
  expect(failure?.presentation?.target).toEqual({ href: logUrl });
  expect(failure?.note).toContain('run-7 failed');
  pendingWatchEvents(true, 'man');
  expect(pendingWatchEvents(false, 'man')).toEqual([]);
});

it.each(['local', 'process'] as const)(
  'stops a terminal %s subscription and retires only after the final tail is consumed',
  async (mode) => {
    const local = localRuntime();
    if (mode === 'process') configureProcess();
    const host = mode === 'process' ? new WatchRuntime(builtinWatchRegistry()) : local.host;
    const registered = host.register(
      'deployment',
      key,
      { fixturePath: historyFile(), subscribeEveryMs: 10 },
      { kind: 'trap', trapId: 'stable-owner', grounds: 'home' },
    );
    history([transition(1, 'failed', true)]);
    streams = new WatchSubscriptionManager(host);
    streams.pass();
    await expect.poll(() => host.journal.read(key)?.status, { timeout: 10000 }).toBe('draining');
    expect(await host.close(key)).toBe(false);
    const files = deploymentFixtureFiles(registered.reference as unknown as DeploymentReference, registered.generation);
    expect(fs.existsSync(files.closed)).toBe(false);
    expect(pendingWatchEvents(false, 'trap:stable-owner')[0]!.events).toHaveLength(1);
    pendingWatchEvents(true, 'trap:stable-owner');
    expect(await host.close(key)).toBe(true);
    streams.pass();
    await streams.dispose();
    expect(host.journal.read(key)?.status).toBe('retired');
    expect(JSON.parse(fs.readFileSync(files.stream, 'utf8'))).toMatchObject({ active: false });
    expect(JSON.parse(fs.readFileSync(files.closed, 'utf8'))).toMatchObject({ key });
    expect(local.provider.activeSubscriptions).toBe(0);
    expect(await host.close(key)).toBe(false);
  },
);

it.each(['local', 'process'] as const)('requires recorded authority for a %s acknowledgment and recovers one provider receipt', (mode) => {
  if (mode === 'process') configureProcess();
  const host = mode === 'process' ? new WatchRuntime(builtinWatchRegistry()) : localRuntime().host;
  const registered = host.register('deployment', key, { fixturePath: historyFile() }, { kind: 'helm', grounds: 'home' });
  history([transition(1, 'failed')]);
  host.checkSync(key, { everySecs: 0 });
  const runner = new WatchActionRunner(host.registry, host.journal);
  const authorization = { id: 'human-approval', by: 'chris', at };
  const request = runner.authorize(
    key,
    {
      actionId: 'acknowledge',
      expectedRevision: '1',
      idempotencyKey: 'ack-1',
      authority: authorization.id,
      arguments: { note: 'Investigated the deployment failure.' },
    },
    authorization,
  );
  expect(() => runner.executeSync(key, { ...request, authorization: { ...authorization, id: 'forged' } })).toThrow(/recorded authority/);
  const result = runner.executeSync(key, request);
  expect(result).toMatchObject({ data: { acknowledged: true, requestId: request.id } });
  expect(runner.executeSync(key, request)).toEqual(result);
  const file = deploymentFixtureFiles(registered.reference as unknown as DeploymentReference, registered.generation).action(request.id);
  const receipt = fs.readFileSync(file, 'utf8');
  // Simulate a host restart before it recorded the provider's successful effect.
  host.journal.update(key, (snapshot) => {
    const action = snapshot!.actionReceipts![0]!;
    action.status = 'pending';
    action.result = undefined;
    return { snapshot, result: undefined };
  });
  expect(new WatchActionRunner(host.registry, host.journal).executeSync(key, request)).toEqual(result);
  expect(fs.readFileSync(file, 'utf8')).toBe(receipt);
  expect(fs.readdirSync(home).filter((name) => name.endsWith('.ack.json'))).toHaveLength(1);
});

it.each(['local', 'process'] as const)(
  'schedules one %s deployment continuation with source instructions across repeated delivery',
  (mode) => {
    if (mode === 'process') configureProcess();
    const host = mode === 'process' ? new WatchRuntime(builtinWatchRegistry()) : localRuntime().host;
    const owner = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const active = path.join(laneDirs('work').active, owner);
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'descriptor.json'), JSON.stringify({ id: owner, repo: 'example', brief: 'Investigate deployment' }));
    appendStatus(owner, 'work', 'done', 'Earlier work finished');
    host.register('deployment', key, { fixturePath: historyFile() }, { kind: 'dispatch', chainId: owner, grounds: 'home' });
    history([transition(1, 'failed')]);
    host.checkSync(key, { everySecs: 0 });
    deliverDispatchOwned(() => {}, 3, host.registry);
    host.checkSync(key, { everySecs: 0 });
    deliverDispatchOwned(() => {}, 3, host.registry);
    const queued = fs
      .readdirSync(laneDirs('work').queue)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, name), 'utf8')));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ followUp: owner, brief: expect.stringContaining(logUrl) });
    expect(queued[0].brief).toContain('report the outcome to its owner');
    expect(host.journal.read(key)!.deliveries).toMatchObject([{ status: 'delivered', continuationId: queued[0].id }]);
  },
);

it('preserves PR and ume event and delivery counts with the configured deployment adapter enabled', () => {
  const result = path.join(home, 'pr-result.json'),
    script = path.join(home, 'pr-check.cjs');
  fs.writeFileSync(result, JSON.stringify({ cursor: '1', events: [{ seq: 'pr-1', summary: 'PR check failed', at }] }));
  fs.writeFileSync(script, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(result)}, 'utf8'))`);
  const read = () => ({ feedbackCount: 1, batches: [{ cursor: 1, entries: [{ seq: 1, kind: 'comments.sent' }] }] });
  const measure = (name: string, enabled: boolean) => {
    if (enabled) configureProcess();
    const host = new WatchRuntime(builtinWatchRegistry({ ume: { read } }), new WatchJournal(path.join(home, name)));
    const owner = { kind: 'helm' as const, grounds: 'home' };
    host.register('pr', 'pr:acme/web#7', { check: `"${process.execPath}" "${script}"` }, owner);
    host.register('ume', 'review-7', { project: 'fixture-project' }, owner);
    if (enabled) {
      host.register('deployment', key, { fixturePath: historyFile() }, owner);
      history([transition(1, 'failed')]);
    }
    const keys = ['pr:acme/web#7', 'ume:review-7', ...(enabled ? [key] : [])];
    host.checkManySync(keys, { everySecs: 0, force: true });
    host.checkManySync(keys, { everySecs: 0, force: true });
    return keys.slice(0, 2).map((sourceKey) => {
      const snapshot = host.journal.read(sourceKey)!;
      return {
        cursor: snapshot.cursor,
        events: snapshot.events.map((event) => event.id),
        deliveries: snapshot.deliveries.map((delivery) => delivery.eventIds),
      };
    });
  };
  const baseline = measure('baseline', false),
    extended = measure('extended', true);
  expect(extended).toEqual(baseline);
  expect(extended).toMatchObject([
    { events: ['pr-1'], deliveries: [['pr-1']] },
    { events: ['1'], deliveries: [['1']] },
  ]);
});

it.each(['local', 'process'] as const)('cancels an idle %s subscription when its source closes', async (mode) => {
  if (mode === 'process') configureProcess();
  const host = mode === 'process' ? new WatchRuntime(builtinWatchRegistry()) : localRuntime().host;
  const registered = host.register('deployment', key, { fixturePath: historyFile() }, { kind: 'helm', grounds: 'home' });
  const files = deploymentFixtureFiles(registered.reference as unknown as DeploymentReference, registered.generation);
  streams = new WatchSubscriptionManager(host);
  streams.pass();
  await expect.poll(() => fs.existsSync(files.stream), { timeout: 10000 }).toBe(true);
  expect(await host.close(key, 'removed')).toBe(true);
  streams.pass();
  await streams.dispose();
  expect(JSON.parse(fs.readFileSync(files.stream, 'utf8'))).toMatchObject({ active: false });
  expect(host.journal.read(key)?.status).toBe('retired');
});
