import { runInDurableObject } from 'cloudflare:test';

/**
 * The rows an account's SQLite writes while `fn` runs, summed from every
 * statement's cursor. Durable Objects bill rows_written: the free tier allows
 * 100,000 a day across the account's objects.
 */
export async function rowsWritten(stub: DurableObjectStub, fn: () => Promise<unknown>): Promise<number> {
  const cursors: Array<{ rowsWritten: number }> = [];
  let restore = () => {};
  await runInDurableObject(stub, (_instance: unknown, state) => {
    const sql = state.storage.sql;
    const exec = sql.exec;
    sql.exec = function (this: SqlStorage, ...args: Parameters<SqlStorage['exec']>) {
      const cursor = exec.apply(this, args);
      cursors.push(cursor);
      return cursor;
    } as SqlStorage['exec'];
    restore = () => {
      sql.exec = exec;
    };
  });
  try {
    await fn();
  } finally {
    await runInDurableObject(stub, () => restore());
  }
  return cursors.reduce((n, c) => n + c.rowsWritten, 0);
}
