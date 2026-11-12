import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error A plain .mjs script with no types.
import { pageOnlyTest, windowsDecision } from '../../../scripts/ci-windows.mjs';

/**
 * CI runs Windows on a pull request only when a change can affect lobstah on
 * a person's Windows machine (scripts/ci-windows.mjs). Glass page, wharf and
 * docs changes skip it; anything unrecognised runs it.
 */

const script = fileURLToPath(new URL('../../../scripts/ci-windows.mjs', import.meta.url));
const decide = (paths: string[], files: Record<string, string> = {}) =>
  windowsDecision(paths, (f: string) => {
    if (!(f in files)) throw new Error(`no ${f}`);
    return files[f];
  }) as { windows: boolean; because?: string };

const pageTest = `import { describe, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';
`;

describe('which changes run Windows', () => {
  it('skips glass page, wharf, telemetry, site, docs and other GitHub changes', () => {
    expect(
      decide([
        'packages/glass-ui/ui/components/prs.ts',
        'packages/glass-ui/ui/glass.css',
        'apps/cli/glass/src/main.ts',
        'services/wharf/src/account.ts',
        'services/telemetry/src/worker.ts',
        'apps/site/index.html',
        'apps/pet/Sources/Pet.swift',
        'docs/man.md',
        'CHANGELOG.md',
        '.github/workflows/release.yml',
      ]),
    ).toEqual({ windows: false });
  });

  it('runs for the CLI, the packages it loads, glass-ui’s Node code, build files and this workflow', () => {
    for (const file of [
      'apps/cli/src/glass.ts',
      'packages/core/src/prs.ts',
      'packages/glass-ui/src/glass-markdown.ts',
      'packages/supervisor/src/index.ts',
      'plugins/claude-code/hooks/hooks.json',
      'scripts/build-glass.mjs',
      'pnpm-lock.yaml',
      'package.json',
      '.gitattributes',
      '.github/workflows/ci.yml',
    ]) {
      expect(decide(['docs/man.md', file]), file).toEqual({ windows: true, because: file });
    }
  });

  it('skips a CLI test that only drives a built glass page, and runs one that loads CLI code or touches the OS', () => {
    const files = {
      'apps/cli/test/glass-page-only.test.ts': pageTest,
      'apps/cli/test/glass-server.test.ts': `${pageTest}import { serveGlass } from '../src/glass.js';\n`,
      'apps/cli/test/glass-temp.test.ts': `${pageTest}import * as path from 'node:path';\n`,
      'apps/cli/test/glass-spawn.test.ts': `${pageTest}import { spawnSync } from 'node:child_process';\n`,
      'apps/cli/test/no-page.test.ts': `import { expect, it } from 'vitest';\n`,
    };
    expect(decide(['apps/cli/test/glass-page-only.test.ts', 'packages/glass-ui/ui/glass.css'], files)).toEqual({ windows: false });
    for (const file of ['apps/cli/test/glass-server.test.ts', 'apps/cli/test/glass-temp.test.ts', 'apps/cli/test/glass-spawn.test.ts', 'apps/cli/test/no-page.test.ts']) {
      expect(decide([file], files), file).toEqual({ windows: true, because: file });
    }
    // A deleted test, or a fixture or helper the page tests share, runs Windows.
    expect(decide(['apps/cli/test/gone.test.ts'], files).windows).toBe(true);
    expect(decide(['apps/cli/test/glass-dom.ts']).windows).toBe(true);
    expect(decide(['apps/cli/test/fixtures/glass-snapshots.ts']).windows).toBe(true);
  });

  it('classifies this repo’s own glass page tests as page-only', () => {
    expect(pageOnlyTest('apps/cli/test/glass-prs-tab.test.ts')).toBe(true);
    expect(pageOnlyTest('apps/cli/test/glass-requests.test.ts')).toBe(false);
  });

  it('prints the decision for $GITHUB_OUTPUT, and runs Windows on an empty list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ci-windows-'));
    try {
      const list = path.join(dir, 'changed.txt');
      const run = (text: string) => {
        fs.writeFileSync(list, text);
        return spawnSync(process.execPath, [script, list], { encoding: 'utf8' });
      };
      const skip = run('services/wharf/src/account.ts\r\ndocs/man.md\n');
      expect(skip.stdout).toBe('windows=false\n');
      expect(skip.stderr).toContain('Windows skips');
      const runs = run('apps/cli/src/main.ts\n');
      expect(runs.stdout).toBe('windows=true\n');
      expect(runs.stderr).toContain('apps/cli/src/main.ts can affect it');
      expect(run('').stdout).toBe('windows=true\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
