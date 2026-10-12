import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Put a `gh` that fails first on PATH, so a test that runs the runner never
 * starts the machine's own GitHub CLI: what that does depends on the machine
 * (signed in or not), and its first start on a Windows CI runner has taken
 * tens of seconds. The stub appends each call's arguments to `calls`.
 * `restore` puts PATH back.
 */
export function stubGh(dir: string): { calls: string; restore: () => void } {
  fs.mkdirSync(dir, { recursive: true });
  const calls = path.join(dir, 'gh-calls');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'gh.cmd'), `@echo off\r\necho %* >> "${calls}"\r\necho gh is stubbed out in this test 1>&2\r\nexit /b 1\r\n`);
  } else {
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\necho gh is stubbed out in this test >&2\nexit 1\n`);
    fs.chmodSync(gh, 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ''}`;
  return {
    calls,
    restore: () => {
      process.env.PATH = previous;
    },
  };
}
