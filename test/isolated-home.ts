import { afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// A timed-out test can keep running after its teardown deletes LOBSTAH_HOME.
// Give that fallback a disposable profile as well as isolating the explicit
// environment. No production path code needs to recognize the test harness.
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  const paths = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const profile = paths.join(actual.tmpdir(), `lobstah-test-profile-${process.pid}-${randomUUID()}`);
  const homedir = () => profile;
  return { ...actual, homedir, default: { ...actual.default, homedir } };
});

const fallback = path.join(os.homedir(), '.lobstah');
process.env.LOBSTAH_HOME = fallback;

// Preserve a disposable environment for late child-process starts too.
afterEach(() => {
  process.env.LOBSTAH_HOME = fallback;
});
