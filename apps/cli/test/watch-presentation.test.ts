import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CommandWatchType,
  WatchRegistry,
  type WatchPresentation,
  type WatchSnapshot,
  type CommandWatchReference,
  type CommandWatchState,
  type CommandWatchOptions,
} from '@lobstah/watch-types';
import { WatchRuntime, ensureLayout, executorPath, pendingWatchEvents, loadConfig } from '@lobstah/core';
import { lobItems } from '@lobstah/glass-ui';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/** This type is intentionally unknown to CLI, helm, hook and glass source code. */
class FixtureWatch extends CommandWatchType {
  readonly descriptor = {
    id: 'fixture',
    apiVersion: 1 as const,
    stateVersion: 1,
    version: '1.0.0',
    attentionKinds: [{ kind: 'fixture:approval', label: 'Fixture approval', defaultEnabled: true }],
  };
  poll() {
    return {
      cursor: '1',
      events: [
        { id: 'feedback-1', kind: 'fixture:approval', summary: 'Review the fixture result', at: new Date().toISOString(), data: null },
      ],
    };
  }
  present(_snapshot: WatchSnapshot<CommandWatchReference, CommandWatchState, string, CommandWatchOptions>): WatchPresentation {
    return {
      title: 'Fixture approval',
      summary: 'Review the fixture result',
      label: 'Fixture approval',
      tone: 'warning',
      worker: { steps: ['Read the fixture feedback and report what changed.'] },
      helm: {
        steps: ['Route this fixture approval to its reviewer.'],
        read: { executable: 'fixture', args: ['feedback', 'approval'], environment: { FIXTURE_PROJECT: 'example' } },
      },
      rows: [{ label: 'Fixture row', value: 'A source-supplied value' }],
      links: [{ label: 'Open fixture', url: 'https://example.test/fixture/approval' }],
      actions: [],
      attention: [
        {
          id: 'approval',
          kind: 'fixture:approval',
          stateHash: 'fixture-revision-1',
          summary: 'Review the fixture result',
          quiet: false,
          blocking: true,
        },
      ],
    };
  }
}

function registeredFixture(): WatchRuntime {
  const registry = new WatchRegistry();
  registry.register(new FixtureWatch());
  expect(registry.attentionKinds()).toEqual([
    { typeId: 'fixture', kind: 'fixture:approval', label: 'Fixture approval', defaultEnabled: true },
  ]);
  const runtime = new WatchRuntime(registry);
  runtime.register('fixture', 'fixture:approval', { check: 'unused' }, { kind: 'helm', grounds: 'fleet' });
  runtime.checkSync('fixture:approval');
  return runtime;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-presentation-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('a registered new type supplies tend rows, instructions and a glass action without consumer edits', () => {
  registeredFixture();
  const report = buildTendReport(),
    row = report.watches.find((watch) => watch.key === 'fixture:approval');
  expect(row).toMatchObject({ pendingEvents: 1, presentation: { rows: [{ label: 'Fixture row', value: 'A source-supplied value' }] } });
  expect(renderTend(report)).toContain('A source-supplied value');
  expect(renderTend(report)).toContain('Route this fixture approval to its reviewer.');
  expect(report.verdict).toBe('needs-attention');
  const condition = report.attention.find((item) => item.kind === 'fixture:approval')!;
  expect(condition.presentation).toMatchObject({ label: 'Fixture approval', target: { href: 'https://example.test/fixture/approval' } });
  const items = lobItems([condition], { lobs: true, preview: false });
  expect(items[0]).toMatchObject({
    label: 'Fixture approval',
    text: 'Review the fixture result',
    href: 'https://example.test/fixture/approval',
  });
  expect(lobItems([{ ...condition, acked: { at: new Date().toISOString(), by: 'test' } }], { lobs: true, preview: false })).toEqual([]);
});

it('the actual wait/Stop-hook output includes a new type’s helm steps and recorded read context', () => {
  const runtime = registeredFixture();
  const result = spawnSync(process.execPath, [cli, 'man', 'wait', '--timeout', '1'], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 10_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('Route this fixture approval to its reviewer.');
  expect(result.stdout).toContain('FIXTURE_PROJECT');
  expect(result.stdout).toContain('example');
  expect(runtime.journal.read('fixture:approval')?.deliveries[0].status).toBe('delivered');
  expect(pendingWatchEvents(false)).toEqual([]);
});

it('configured type namespaces are extensible and explicit attention selection overrides source defaults', () => {
  registeredFixture();
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    'schemaVersion=2\n[watches.attention]\nenabledKinds=["fixture:approval"]\n[watchTypes.fixture]\nenabled=true\nmodule="builtin:fixture"\n',
  );
  expect(loadConfig().attentionKinds).toEqual(['fixture:approval']);
  expect(buildTendReport().attention.some((item) => item.kind === 'fixture:approval')).toBe(true);
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    'schemaVersion=2\n[watches.attention]\nenabledKinds=[]\n[watchTypes.fixture]\nenabled=true\nmodule="builtin:fixture"\n',
  );
  expect(buildTendReport().attention.some((item) => item.kind === 'fixture:approval')).toBe(false);
});

it('repeated observations keep a standing condition’s timestamp and registered kinds reject typos', () => {
  const runtime = registeredFixture();
  const before = runtime.journal.read('fixture:approval')!.presentation.attention[0].since;
  runtime.checkSync('fixture:approval', { now: Date.now() + 60_000 });
  expect(runtime.journal.read('fixture:approval')!.presentation.attention[0].since).toBe(before);
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    'schemaVersion=2\n[watches.attention]\nenabledKinds=["fixture:missing"]\n[watchTypes.fixture]\nenabled=true\n',
  );
  expect(() => loadConfig()).toThrow('unknown kind');
});
