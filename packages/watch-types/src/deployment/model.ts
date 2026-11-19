import { pluginSchema, type PluginJsonSchema } from '../plugin-model.js';
import type { WatchActionRequest, WatchContext, WatchEffectResult, WatchObservationBatch, WatchSchema } from '../model.js';

/** Provider identity is stable when a fixture's observations change. */
export interface DeploymentReference {
  environment: string;
  deploymentId: string;
  fixturePath: string;
}
export type DeploymentPhase = 'queued' | 'deploying' | 'failed' | 'succeeded' | 'cancelled';
/** A provider sequence orders progress even when polling and subscriptions overlap. */
export interface DeploymentState {
  sequence: number;
  phase: DeploymentPhase;
  logUrl: string;
  terminal: boolean;
}
export interface DeploymentOptions {
  fixturePath: string;
  subscribeEveryMs?: number;
}
export interface DeploymentTransition extends DeploymentState {
  environment: string;
  deploymentId: string;
  at: string;
}
export type DeploymentContext = WatchContext<DeploymentReference, DeploymentState, number, DeploymentOptions>;

/** Loading an unused adapter exposes schema metadata without compiling provider validators. */
function deploymentSchema<T>(json: PluginJsonSchema, label: string): WatchSchema<T> {
  let compiled: WatchSchema<T> | undefined;
  return {
    json,
    parse(value) {
      compiled ??= pluginSchema<T>(json, label);
      return compiled.parse(value);
    },
  };
}

const name = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' };
const sequence = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const stateProperties = {
  sequence,
  phase: { enum: ['queued', 'deploying', 'failed', 'succeeded', 'cancelled'] },
  logUrl: { type: 'string', pattern: '^(https?://|$)' },
  terminal: { type: 'boolean' },
};
export const deploymentReferenceSchema = deploymentSchema<DeploymentReference>(
  {
    type: 'object',
    required: ['environment', 'deploymentId', 'fixturePath'],
    additionalProperties: false,
    properties: { environment: name, deploymentId: name, fixturePath: { type: 'string', minLength: 1 } },
  },
  'Deployment reference',
);
export const deploymentStateSchema = deploymentSchema<DeploymentState>(
  { type: 'object', required: ['sequence', 'phase', 'logUrl', 'terminal'], additionalProperties: false, properties: stateProperties },
  'Deployment state',
);
export const deploymentCursorSchema = deploymentSchema<number>(sequence, 'Deployment cursor');
export const deploymentOptionsSchema = deploymentSchema<DeploymentOptions>(
  {
    type: 'object',
    required: ['fixturePath'],
    additionalProperties: false,
    properties: { fixturePath: { type: 'string', minLength: 1 }, subscribeEveryMs: { type: 'integer', minimum: 1, maximum: 1000 } },
  },
  'Deployment options',
);
export const deploymentHistorySchema = deploymentSchema<DeploymentTransition[]>(
  {
    type: 'array',
    maxItems: 10000,
    items: {
      type: 'object',
      required: ['environment', 'deploymentId', 'sequence', 'phase', 'logUrl', 'terminal', 'at'],
      additionalProperties: false,
      properties: { ...stateProperties, environment: name, deploymentId: name, at: { type: 'string', format: 'date-time' } },
    },
  },
  'Deployment fixture history',
);
/** Human effects have an explicit payload schema as well as the shared authority envelope. */
export const deploymentActionSchemas: { arguments: PluginJsonSchema; result: PluginJsonSchema } = {
  arguments: {
    type: 'object',
    required: ['note'],
    additionalProperties: false,
    properties: { note: { type: 'string', minLength: 1, maxLength: 500 } },
  },
  result: {
    type: 'object',
    required: ['workIds', 'data'],
    additionalProperties: false,
    properties: {
      workIds: { type: 'array', maxItems: 0 },
      data: {
        type: 'object',
        required: ['acknowledged', 'requestId'],
        additionalProperties: false,
        properties: { acknowledged: { const: true }, requestId: { type: 'string' } },
      },
    },
  },
};

/** Observation, streaming, authorized effects and cleanup compose behind one source-owned provider. */
export interface DeploymentProvider {
  observe(context: DeploymentContext): WatchObservationBatch<number>;
  subscribe(context: DeploymentContext): AsyncIterable<WatchObservationBatch<number>>;
  acknowledge(request: WatchActionRequest<DeploymentReference>): WatchEffectResult;
  close(context: DeploymentContext): Promise<void>;
}
