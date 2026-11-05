import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firstHeavyReminder, heavyCommandPattern, heavyReminderText } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

describe('what counts as a heavy command', () => {
  it.each([
    ['npx vitest run', 'vitest run'],
    ['pnpm vitest run', 'vitest run'],
    ['pnpm exec vitest run --reporter=dot', 'vitest run'],
    ['env -u CLAUDE_CODE_SESSION_ID npx vitest run', 'vitest run'],
    ['CI=1 FOO=bar npx vitest run > out.log 2>&1', 'vitest run'],
    ['cd apps/web && npx vitest run', 'vitest run'],
    ['npx playwright test', 'playwright test'],
    ['turbo run build --concurrency=2', 'turbo run'],
    ['pnpm -s turbo run test', 'turbo run'],
    ['pnpm test', 'pnpm test'],
    ['pnpm -s test', 'pnpm test'],
    ['pnpm -s -r run build > build.log 2>&1', 'pnpm -r run build'],
    ['npm test', 'npm test'],
  ])('%s', (command, pattern) => {
    expect(heavyCommandPattern(command)).toBe(pattern);
  });

  it.each([
    'npx vitest run apps/cli/test/heavy.test.ts',
    'npx playwright test e2e/login.spec.ts',
    'lobstah heavy -- npx vitest run',
    'git push origin main',
    'pnpm -F @lobstah/core build',
    'echo pnpm test',
    'grep -r "vitest run" .',
    '',
  ])('not %s', (command) => {
    expect(heavyCommandPattern(command)).toBeUndefined();
  });

  it('takes a repo\'s own names', () => {
    expect(heavyCommandPattern('pnpm test:e2e')).toBeUndefined();
    expect(heavyCommandPattern('pnpm test:e2e --headed', ['pnpm test:e2e'])).toBe('pnpm test:e2e');
  });

  it('tells the trap how to run it next time', () => {
    expect(heavyReminderText('npx vitest run')).toBe("lobstah: this looks like a full test run or build and it wasn't queued.\nNext time use: lobstah heavy -- npx vitest run");
    expect(heavyReminderText('cd web && npx vitest run > out.log 2>&1; echo done')).toContain('lobstah heavy -- npx vitest run\n'.trimEnd());
    expect(heavyReminderText('cd web && npx vitest run > out.log 2>&1; echo done')).not.toContain('echo');
  });
});

describe('reminding once', () => {
  let home: string;
  const prior = process.env.LOBSTAH_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reminder-'));
    process.env.LOBSTAH_HOME = home;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.LOBSTAH_HOME;
    else process.env.LOBSTAH_HOME = prior;
    removeTempDir(home);
  });

  it('fires once per dispatch for each pattern', () => {
    expect(firstHeavyReminder('d1', 'vitest run')).toBe(true);
    expect(firstHeavyReminder('d1', 'vitest run')).toBe(false);
    expect(firstHeavyReminder('d1', 'turbo run')).toBe(true);
    expect(firstHeavyReminder('d2', 'vitest run')).toBe(true);
  });

  it('stays silent when its state cannot be written', () => {
    fs.writeFileSync(path.join(home, 'heavy'), 'in the way');
    expect(firstHeavyReminder('d1', 'vitest run')).toBe(false);
  });
});
