import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DeploymentWatchType, ProcessWatchType, disposeWatchPlugins, parseWatchPluginConfiguration } from '../dist/index.js';
import type {
  DeploymentState,
  DeploymentTransition,
  WatchSnapshot,
  DeploymentOptions,
  DeploymentReference,
  WatchValue,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
const program = fileURLToPath(new URL('../dist/deployment/plugin.js', import.meta.url));
const at = '2026-11-19T00:00:00.000Z',
  logUrl = 'https://deploy.example.test/logs/run-7';
const transition = (sequence: number, phase: DeploymentState['phase'], terminal = false): DeploymentTransition => ({
  environment: 'production',
  deploymentId: 'run-7',
  at,
  sequence,
  phase,
  terminal,
  logUrl,
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-deployment-parity-'));
});
afterEach(async () => {
  await disposeWatchPlugins();
  removeTempDir(home);
});
function snapshot(): WatchSnapshot<DeploymentReference, DeploymentState, number, DeploymentOptions> {
  const adapter = new DeploymentWatchType(),
    options = { fixturePath: path.join(home, 'history.json') },
    reference = adapter.identify('deployment:production/run-7', options)!;
  return {
    key: adapter.key(reference),
    type: adapter.descriptor,
    reference,
    options,
    ...adapter.initialize(),
    owner: { kind: 'helm', grounds: 'home' },
    generation: 'parity-generation',
    status: 'watching',
    events: [],
    deliveries: [],
    failures: 0,
    createdAt: at,
    presentation: {
      title: '',
      label: '',
      summary: '',
      tone: 'neutral',
      rows: [],
      links: [],
      actions: [],
      attention: [],
      worker: { steps: [] },
      helm: { steps: [] },
    },
  };
}

it('runs one deployment history through both hosts with equal events, role instructions, presentation and terminal state', () => {
  const local = new DeploymentWatchType();
  const remote = new ProcessWatchType(
    parseWatchPluginConfiguration('deployment', { command: [process.execPath, program], version: '1.0.0' }),
  );
  let direct = snapshot(),
    processSnapshot = { ...snapshot(), type: remote.descriptor } as unknown as WatchSnapshot<
      WatchValue,
      WatchValue,
      WatchValue,
      WatchValue
    >;
  const history: DeploymentTransition[] = [];
  for (const next of [transition(1, 'deploying'), transition(2, 'failed'), transition(3, 'succeeded', true)]) {
    history.push(next);
    fs.writeFileSync(direct.options.fixturePath, JSON.stringify(history));
    const expected = local.poll({ snapshot: direct, now: at }),
      observed = remote.poll({ snapshot: processSnapshot, now: at });
    expect(observed).toEqual(expected);
    const localPlan = local.reduce(direct, expected),
      processPlan = remote.reduce(processSnapshot, observed);
    expect(processPlan).toEqual(localPlan);
    direct = { ...direct, state: localPlan.state, cursor: localPlan.cursor };
    processSnapshot = { ...processSnapshot, state: processPlan.state, cursor: processPlan.cursor };
    expect(remote.present(processSnapshot)).toEqual(local.present(direct));
    expect(local.present(direct).links).toEqual([{ label: 'Open deployment logs', url: logUrl }]);
  }
  expect(direct.state).toMatchObject({ phase: 'succeeded', terminal: true });
});

it('rejects malformed histories and prevents a delayed stream batch from regressing the checkpoint', () => {
  const adapter = new DeploymentWatchType(),
    current = snapshot();
  current.state = { sequence: 3, phase: 'succeeded', terminal: true, logUrl };
  current.cursor = 3;
  expect(adapter.reduce(current, { cursor: 2, events: [], payload: { sequence: 2, phase: 'failed', logUrl, terminal: false } })).toEqual({
    state: current.state,
    cursor: 3,
    done: true,
  });
  fs.writeFileSync(current.options.fixturePath, JSON.stringify([transition(2, 'failed'), transition(1, 'deploying')]));
  expect(() => adapter.poll({ snapshot: current, now: at })).toThrow(/sequences/);
});
