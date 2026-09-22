import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimNext, enqueue, ensureLayout } from '@lobstah/core';
import { LinearSource } from '../src/sources/linear.js';
import { PickupState } from '../src/state.js';
import { reconcileLoop } from '../src/loops/reconcile.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-linear-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function source(assignField: 'assignee' | 'delegate' = 'delegate', startStateTypes?: string[]) {
  return new LinearSource({
    token: () => 't', assignField, startState: 'Todo', startStateTypes,
    claimedState: 'In Progress', doneState: 'In Review', route: { DEMO: 'demo' },
  });
}

function issue(identifier: string, name: string, type: string) {
  return { id: identifier, identifier, title: 't', description: null, state: { name, type }, team: { key: 'DEMO', id: 'team' } };
}

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('Linear reconciliation', () => {
  it.each(['assignee', 'delegate'] as const)('sees closed issues beyond the first page using %s', async (field) => {
    const calls: Array<{ query: string; variables: any }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      calls.push(call);
      const second = call.variables.after === 'next';
      return response({ issues: {
        nodes: second
          ? [issue('DEMO-2', 'Done', 'completed'), issue('DEMO-3', 'Cancelled', 'canceled')]
          : [issue('DEMO-1', 'In Progress', 'started')],
        pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next' },
      } });
    });
    expect(await source(field).inProgress()).toEqual([
      { key: 'linear:DEMO-1', open: true },
      { key: 'linear:DEMO-2', open: false },
      { key: 'linear:DEMO-3', open: false },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables.filter).toEqual({
      [field]: { isMe: { eq: true } },
      or: [{ state: { name: { eq: 'In Progress' } } }, { state: { type: { in: ['completed', 'canceled'] } } }],
    });
    expect(calls[1]!.variables.filter).toEqual(calls[0]!.variables.filter);
    expect(calls[1]!.query).toContain('after: $after');
  });

  it.each(['completed', 'canceled'])('cancels a live dispatch whose Linear item is %s', async (type) => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    enqueue({ id: uuid, repo: 'demo', brief: 'work' }, 'work');
    claimNext('work');
    const st = new PickupState();
    st.set('linear:DEMO-1', { uuid, kind: 'issue', createdAt: new Date().toISOString() });
    vi.stubGlobal('fetch', async () => response({ issues: {
      nodes: [issue('DEMO-1', 'Closed', type)],
      pageInfo: { hasNextPage: false, endCursor: null },
    } }));
    await reconcileLoop(source(), st);
    expect(fs.existsSync(path.join(home, 'active', uuid, 'cancel'))).toBe(true);
  });

  it('keeps a closed issue closed when its cancelled dispatch reports failed', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      queries.push(query);
      if (query.includes('issue(id:')) return response({ issue: issue('DEMO-1', 'Cancelled', 'canceled') });
      if (query.includes('commentCreate')) return response({ commentCreate: { success: true } });
      throw new Error(`unexpected mutation: ${query}`);
    });
    await source().report('linear:DEMO-1', 'failed', { uuid: 'u' });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('commentCreate');
  });

  it.each([undefined, ['backlog', 'unstarted']])('preserves the pickup filter for startStateTypes = %s', async (types) => {
    let filter: unknown;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      filter = JSON.parse(String(init.body)).variables.filter;
      return response({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    });
    await source('delegate', types).poll();
    expect(filter).toEqual({ delegate: { isMe: { eq: true } }, state: types ? { type: { in: types } } : { name: { eq: 'Todo' } } });
  });
});
