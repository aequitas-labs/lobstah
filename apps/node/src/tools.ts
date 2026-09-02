import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  enqueue,
  ensureLayout,
  laneDirs,
  lastEventAt,
  readStatusLog,
  reconcile,
  requestCancel,
  sendMessage,
  toonKV,
  toonTable,
} from '@lobstah/core';
import type { Descriptor, Lane } from '@lobstah/core';
import type { AgentToolResult, AnyAgentTool } from 'openclaw/plugin-sdk/core';

function text(payload: string, details: unknown = {}): AgentToolResult {
  return { content: [{ type: 'text', text: payload }], details };
}

function findLane(id: string): Lane {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    if (
      fs.existsSync(path.join(d.active, id)) ||
      fs.existsSync(path.join(d.queue, `${id}.json`)) ||
      fs.existsSync(path.join(d.done, id)) ||
      fs.existsSync(path.join(d.state, `${id}.status`))
    ) {
      return lane;
    }
  }
  throw new Error(`unknown dispatch ${id}`);
}

function stateOf(id: string, lane: Lane): string {
  return reconcile({ log: readStatusLog(id, lane), lastEventAt: lastEventAt(id, lane) });
}

function param(params: unknown, key: string): string | undefined {
  const v = (params as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function dispatchTool(): AnyAgentTool {
  return {
    name: 'lobstah_dispatch',
    label: 'Lobstah dispatch',
    description:
      'Queue a supervised coding-agent dispatch on this host. The lobstah daemon claims it, allocates an isolated git worktree, runs the agent, and reports status to disk. Returns the dispatch id.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Lobstah repo key from the host config' },
        brief: { type: 'string', description: 'The full work brief for the dispatched agent' },
        harness: { type: 'string', enum: ['claude', 'codex'] },
        model: { type: 'string' },
        effort: { type: 'string' },
        followUp: { type: 'string', description: 'Earlier dispatch UUID whose session to fork' },
      },
      required: ['repo', 'brief'],
      additionalProperties: false,
    },
    async execute(_id, params) {
      ensureLayout();
      const repo = param(params, 'repo');
      const brief = param(params, 'brief');
      if (!repo || !brief) throw new Error('lobstah_dispatch requires repo and brief');
      const d: Descriptor = {
        id: randomUUID(),
        repo,
        brief,
        harness: param(params, 'harness'),
        model: param(params, 'model'),
        effort: param(params, 'effort'),
        followUp: param(params, 'followUp'),
      };
      enqueue(d, 'work');
      return text(toonKV({ id: d.id, repo, queued: new Date().toISOString() }), { id: d.id });
    },
  };
}

export function statusTool(): AnyAgentTool {
  return {
    name: 'lobstah_status',
    label: 'Lobstah status',
    description:
      'Reconciled state of one dispatch (by id) or every active dispatch on this host. States: working, needs-decision, blocked, paused, done, failed, unknown.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
    async execute(_id, params) {
      ensureLayout();
      const id = param(params, 'id');
      if (id) {
        const lane = findLane(id);
        const log = readStatusLog(id, lane);
        const state = stateOf(id, lane);
        return text(toonKV({ id, lane, state, lastNote: log.at(-1)?.note }), { id, state });
      }
      const rows = (['work', 'chore'] as Lane[]).flatMap((lane) =>
        fs
          .readdirSync(laneDirs(lane).active)
          .filter((f) => !f.startsWith('.'))
          .map((did) => ({ id: did, lane, state: stateOf(did, lane) })),
      );
      return text(toonTable('active', rows, ['id', 'lane', 'state']), { count: rows.length });
    },
  };
}

export function sendTool(): AnyAgentTool {
  return {
    name: 'lobstah_send',
    label: 'Lobstah send',
    description:
      'Send an instruction to a running dispatch. Delivered into its inbox between agent turns.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, message: { type: 'string' } },
      required: ['id', 'message'],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const id = param(params, 'id');
      const message = param(params, 'message');
      if (!id || !message) throw new Error('lobstah_send requires id and message');
      const name = sendMessage(id, findLane(id), message);
      return text(toonKV({ id, queued: name }), { id });
    },
  };
}

export function cancelTool(): AnyAgentTool {
  return {
    name: 'lobstah_cancel',
    label: 'Lobstah cancel',
    description: 'Request cancellation of an active dispatch. The supervisor kills it between polls.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const id = param(params, 'id');
      if (!id) throw new Error('lobstah_cancel requires id');
      requestCancel(id, findLane(id));
      return text(toonKV({ id, cancel: 'requested' }), { id });
    },
  };
}
