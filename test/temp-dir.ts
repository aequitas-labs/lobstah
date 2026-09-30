import * as fs from 'node:fs';

/**
 * Remove a test's temp directory. Windows holds file handles for a moment
 * after git or a child process exits, so a delete can fail with EBUSY or
 * EPERM. Node retries those errors with a linear backoff.
 */
export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
