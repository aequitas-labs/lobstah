import { it } from 'vitest';

/** Integration tests that spawn git or the CLI need startup headroom on Windows and on shared fleet hosts. */
export const processTest = (name: string, run: () => void | Promise<void>) =>
  it(name, run, 30_000);
