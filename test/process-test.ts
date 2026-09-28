import { it } from 'vitest';

/** Integration tests that spawn git or the CLI need more startup headroom on Windows. */
export const processTest = (name: string, run: () => void | Promise<void>) =>
  it(name, run, process.platform === 'win32' ? 30_000 : undefined);
