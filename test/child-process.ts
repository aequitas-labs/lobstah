import type { ChildProcess } from 'node:child_process';

/**
 * Kill the children that are still running and wait until each has exited.
 * A kill only asks: the process keeps its working directory and open files
 * until it is gone, and Windows refuses to remove a directory a process
 * stands in (EBUSY). A teardown ends its children here before it removes
 * the directory they ran in.
 */
export async function stopChildren(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          // Never started (spawn failed), or already gone.
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
}
