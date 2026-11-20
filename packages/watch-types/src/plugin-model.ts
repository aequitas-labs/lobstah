import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import type { WatchFailure, WatchPresentation, WatchRegistrationBinding, WatchSchema, WatchTypeDescriptor, WatchValue } from './model.js';
import { watchJson } from './registry.js';
import {
  WATCH_ACTION_GLYPHS,
  WATCH_ACTION_PLACEMENTS,
  WATCH_ATTENTION_STATES,
  WATCH_GLYPHS,
  WATCH_LIFECYCLE_PHASES,
  WATCH_METADATA_KINDS,
  WATCH_STATUS_CATEGORIES,
  WATCH_STATUS_MEANINGS,
  WATCH_SURFACES,
  validWatchTarget,
} from './items.js';
import type { WatchItem, WatchPresentationVersion } from './items.js';

export const WATCH_PLUGIN_PROTOCOL = 1 as const;
/** The newest presentation contract this host renders; it also accepts every older one. */
export const WATCH_PRESENTATION_PROTOCOL = 2 as const;
export const WATCH_PLUGIN_CAPABILITIES = ['poll', 'batch', 'subscribe', 'actions', 'automation', 'dispatch', 'derived', 'notices', 'registration', 'commands', 'triggers', 'acknowledgements'] as const;
export type WatchPluginCapability = (typeof WATCH_PLUGIN_CAPABILITIES)[number];
export type PluginJsonSchema = Record<string, WatchValue>;

/** Installation settings contain environment names, never the credential values passed to a child. */
export interface WatchPluginConfiguration {
  id: string;
  command: string[];
  version: string;
  apiVersion: 1;
  cwd?: string;
  envAllow: string[];
  allowCapabilities: WatchPluginCapability[];
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  maxMessageBytes: number;
  maxRestarts: number;
  restartWindowMs: number;
  restartBackoffMs: number;
}
export interface WatchPluginManifest {
  protocolVersion: 1;
  /** The presentation contract `watch.present` returns; the process transport stays at protocol 1. */
  presentationVersion: WatchPresentationVersion;
  descriptor: WatchTypeDescriptor;
  schemas: { reference: PluginJsonSchema; options: PluginJsonSchema; state: PluginJsonSchema; cursor: PluginJsonSchema };
  bindings: WatchRegistrationBinding[];
  capabilities: {
    acknowledgements?: { patterns: string[] };
    triggers?: boolean;
    commands?: { bindings: Array<{ name: string; pattern?: string }> };
    registration?: boolean;
    batch?: boolean;
    subscribe?: boolean;
    actions?: { authorityRequired: true; arguments: PluginJsonSchema; result: PluginJsonSchema };
    automation?: boolean;
    dispatch?: boolean;
    derived?: boolean;
    notices?: { kinds: string[]; quietKinds?: string[] };
  };
}

/** Every operation and subscription notification is fenced to its original watch generation. */
export interface WatchPluginContext {
  protocolVersion: 1;
  watchKey: string;
  generation: string;
  deadline: number;
}
export interface WatchPluginRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: WatchPluginContext & { body: WatchValue };
}
export interface WatchPluginReply {
  jsonrpc: '2.0';
  id: string;
  result?: WatchValue;
  error?: { code: number; message: string; data?: { failure?: WatchFailure } };
}
export interface WatchPluginNotification {
  jsonrpc: '2.0';
  method: 'watch.observation';
  params: WatchPluginContext & { requestId: string; batch: WatchValue };
}

/** Host faults hold only the affected watches and retain their last committed cursor. */
export class WatchPluginError extends Error {
  readonly failure: WatchFailure;
  constructor(message: string, failure?: WatchFailure) {
    super(message);
    this.name = 'WatchPluginError';
    this.failure = failure ?? {
      kind: 'plugin',
      message,
      hold: true,
      remedy: 'Check the configured watch plugin version and command, then release the watch after its restart backoff.',
    };
  }
}

const ajv = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
});
const validators = new Map<string, ValidateFunction>();

/** Compile once, with no mutation, coercion, network schema loading or asynchronous validators. */
export function pluginSchema<T = WatchValue>(schema: PluginJsonSchema, label: string): WatchSchema<T> {
  watchJson(schema);
  if (schema.$async) throw new WatchPluginError(`${label} must use a synchronous JSON schema`);
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      throw new WatchPluginError(`${label}: invalid JSON schema: ${String(error)}`);
    }
    validators.set(key, validate);
  }
  const compiled = validate;
  return {
    json: schema,
    parse(value) {
      watchJson(value);
      if (!compiled(value)) throw new WatchPluginError(`${label}: ${ajv.errorsText(compiled.errors)}`);
      return structuredClone(value) as T;
    },
  };
}
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const object = { type: 'object' };
const schema = object;
const instructions: PluginJsonSchema = {
  type: 'object',
  required: ['steps'],
  additionalProperties: false,
  properties: {
    steps: strings,
    read: {
      type: 'object',
      required: ['executable', 'args'],
      additionalProperties: false,
      properties: { executable: string, args: strings, cwd: string, environment: { type: 'object', additionalProperties: string } },
    },
  },
};
const suppression: PluginJsonSchema = {
  type: 'object',
  required: ['key', 'kind'],
  additionalProperties: false,
  properties: { key: string, kind: string },
};
const target: PluginJsonSchema = {
  oneOf: [
    { type: 'object', required: ['href'], additionalProperties: false, properties: { href: string } },
    { type: 'object', required: ['hash'], additionalProperties: false, properties: { hash: string } },
    {
      type: 'object',
      required: ['open'],
      additionalProperties: false,
      properties: {
        open: {
          type: 'object',
          required: ['type', 'key'],
          additionalProperties: false,
          properties: { type: { enum: ['dispatch', 'trap', 'helm', 'pr', 'review', 'settings'] }, key: string },
        },
      },
    },
  ],
};
const attentionDisplay: PluginJsonSchema = {
  type: 'object',
  required: ['itemKey', 'text', 'label', 'cliKind', 'cliVerb', 'badgeText', 'badgeClass', 'acknowledge', 'always', 'blocking'],
  additionalProperties: false,
  properties: {
    family: { enum: ['question', 'decision', 'landed', 'report', 'review', 'pr', 'stack', 'notice', 'dispatch'] },
    shared: { type: 'boolean' },
    links: { type: 'array', items: { type: 'object', required: ['label', 'url'], additionalProperties: false, properties: { label: string, url: string } } },
    itemKey: string,
    text: string,
    label: string,
    cliKind: string,
    cliVerb: string,
    badgeText: string,
    badgeClass: string,
    afterBadge: string,
    viewedBy: { enum: ['viewedAt', 'ack'] },
    target,
    acknowledge: { type: 'boolean' },
    always: { type: 'boolean' },
    blocking: { type: 'boolean' },
    enabledBy: strings,
    suppressesKeys: strings,
    suppresses: { type: 'array', items: suppression },
  },
};

const action: PluginJsonSchema = {
  type: 'object',
  required: ['id', 'label', 'requiresAuthority'],
  additionalProperties: false,
  properties: { id: string, label: string, requiresAuthority: { type: 'boolean' }, automatic: { type: 'boolean' } },
};
const presentationProperties: Record<string, PluginJsonSchema> = {
  title: string,
  summary: string,
  label: string,
  tone: { enum: ['neutral', 'ok', 'warning', 'risk'] },
  listing: { enum: ['watch', 'conditions'] },
  suppresses: { type: 'array', items: suppression },
  worker: instructions,
  helm: instructions,
  rows: {
    type: 'array',
    items: { type: 'object', required: ['label', 'value'], additionalProperties: false, properties: { label: string, value: string } },
  },
  links: {
    type: 'array',
    items: { type: 'object', required: ['label', 'url'], additionalProperties: false, properties: { label: string, url: string } },
  },
  actions: { type: 'array', items: action },
  attention: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'kind', 'stateHash', 'summary', 'quiet', 'blocking'],
      additionalProperties: false,
      properties: {
        id: string,
        key: string,
        kind: string,
        stateHash: string,
        since: { type: 'string', format: 'date-time' },
        summary: string,
        quiet: { type: 'boolean' },
        blocking: { type: 'boolean' },
        fields: object,
        presentation: attentionDisplay,
      },
    },
  },
};
const presentationRequired = ['title', 'summary', 'label', 'tone', 'worker', 'helm', 'rows', 'links', 'actions', 'attention'];

/** Version 1 accepts declarative presentation only; HTML, CSS and executable modules have no protocol fields. */
export const watchPresentationSchema: PluginJsonSchema = {
  type: 'object',
  required: presentationRequired,
  additionalProperties: false,
  properties: presentationProperties,
};

const nonEmpty = { type: 'string', minLength: 1 };
const time = { type: 'string', format: 'date-time' };
const glyph = { enum: [...WATCH_GLYPHS] };
const icon: PluginJsonSchema = {
  oneOf: [
    { type: 'object', required: ['glyph'], additionalProperties: false, properties: { glyph } },
    {
      type: 'object',
      required: ['asset', 'fallback'],
      additionalProperties: false,
      properties: {
        asset: { type: 'object', required: ['light', 'dark'], additionalProperties: false, properties: { light: nonEmpty, dark: nonEmpty } },
        fallback: glyph,
      },
    },
  ],
};
const phase = { enum: [...WATCH_LIFECYCLE_PHASES] };
const itemAction: PluginJsonSchema = {
  type: 'object',
  required: ['id', 'label', 'placement', 'enabled', 'binding'],
  additionalProperties: false,
  properties: {
    id: nonEmpty,
    label: nonEmpty,
    glyph: { enum: [...WATCH_ACTION_GLYPHS] },
    placement: { enum: [...WATCH_ACTION_PLACEMENTS] },
    enabled: { type: 'boolean' },
    reason: string,
    title: string,
    progress: string,
    done: string,
    acknowledges: { type: 'boolean' },
    pressed: { type: 'boolean' },
    confirm: {
      type: 'object',
      required: ['title', 'body', 'label'],
      additionalProperties: false,
      properties: { title: nonEmpty, body: string, label: nonEmpty },
    },
    binding: {
      oneOf: [
        { type: 'object', required: ['link'], additionalProperties: false, properties: { link: target } },
        {
          type: 'object',
          required: ['effect'],
          additionalProperties: false,
          properties: {
            effect: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: nonEmpty, arguments: {} } },
          },
        },
      ],
    },
  },
};
const item: PluginJsonSchema = {
  type: 'object',
  required: ['id', 'revision', 'title', 'kind', 'glyph', 'lifecycle', 'statuses', 'attention', 'metadata', 'actions', 'surfaces'],
  additionalProperties: false,
  properties: {
    id: nonEmpty,
    revision: nonEmpty,
    title: string,
    subtitle: string,
    kind: nonEmpty,
    glyph: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: glyph,
        variants: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(WATCH_LIFECYCLE_PHASES.map((name) => [name, glyph])),
        },
      },
    },
    lifecycle: {
      type: 'object',
      required: ['phase', 'label'],
      additionalProperties: false,
      properties: { phase, label: nonEmpty, archived: { type: 'boolean' } },
    },
    statuses: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        required: ['code', 'label', 'category', 'meaning'],
        additionalProperties: false,
        properties: {
          code: nonEmpty,
          label: nonEmpty,
          category: { enum: [...WATCH_STATUS_CATEGORIES] },
          meaning: { enum: [...WATCH_STATUS_MEANINGS] },
          detail: string,
          target,
          at: time,
          note: string,
        },
      },
    },
    attention: { enum: [...WATCH_ATTENTION_STATES] },
    notification: {
      type: 'object',
      required: ['revision', 'unread'],
      additionalProperties: false,
      properties: { revision: nonEmpty, unread: { type: 'boolean' }, seen: { type: 'boolean' }, action: nonEmpty },
    },
    standing: { type: 'boolean' },
    answered: { type: 'boolean' },
    resolved: { type: 'boolean' },
    person: {
      type: 'object',
      required: ['id', 'role'],
      additionalProperties: false,
      properties: {
        id: nonEmpty,
        name: string,
        avatarUrl: string,
        role: nonEmpty,
        badge: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: nonEmpty, detail: string } },
      },
    },
    metadata: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        required: ['kind', 'value'],
        additionalProperties: false,
        properties: { kind: { enum: [...WATCH_METADATA_KINDS] }, value: nonEmpty, label: string },
      },
    },
    notes: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
        properties: { text: nonEmpty, label: string, meaning: { enum: [...WATCH_STATUS_MEANINGS] } },
      },
    },
    requestedAt: time,
    updatedAt: time,
    target,
    actions: { type: 'array', maxItems: 16, items: itemAction },
    surfaces: {
      type: 'object',
      required: ['list'],
      additionalProperties: false,
      properties: {
        list: { type: 'array', uniqueItems: true, items: { enum: [...WATCH_SURFACES] } },
        home: { enum: [...WATCH_SURFACES] },
      },
    },
    group: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: nonEmpty, title: string, position: { type: 'integer', minimum: 0 } },
    },
    repo: nonEmpty,
  },
};

/**
 * Version 2 adds the source brand, typed items and effect argument schemas.
 * Colors, opacity, CSS classes, layout variants and markup still have no
 * fields, so a source that sends them is rejected.
 */
export const watchPresentationSchemaV2: PluginJsonSchema = {
  type: 'object',
  required: [...presentationRequired, 'version', 'source', 'items'],
  additionalProperties: false,
  properties: {
    ...presentationProperties,
    version: { const: 2 },
    source: {
      type: 'object',
      required: ['id', 'name', 'icon'],
      additionalProperties: false,
      properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9.-]*$' }, name: nonEmpty, icon },
    },
    items: { type: 'array', maxItems: 1000, items: item },
    surfaces: { type: 'array', uniqueItems: true, items: { enum: [...WATCH_SURFACES] } },
    actions: {
      type: 'array',
      items: { ...action, properties: { ...(action.properties as Record<string, WatchValue>), arguments: object } },
    },
  },
};

/** Item references must resolve: unique IDs, valid targets, and effects bound to a declared human action. */
function validateWatchItems(presentation: WatchPresentation): void {
  const declared = new Map(presentation.actions.map((entry) => [entry.id, entry]));
  const ids = new Set<string>();
  const targets = (entry: WatchItem) => [
    entry.target,
    ...entry.statuses.map((status) => status.target),
    ...entry.actions.map((control) => ('link' in control.binding ? control.binding.link : undefined)),
  ];
  for (const entry of presentation.items ?? []) {
    if (ids.has(entry.id)) throw new WatchPluginError(`Watch presentation repeats item ${entry.id}`);
    ids.add(entry.id);
    for (const destination of targets(entry))
      if (destination && !validWatchTarget(destination)) throw new WatchPluginError(`Watch item ${entry.id} has an invalid target`);
    const acknowledgement = entry.notification?.action;
    if (acknowledgement) {
      const declaration = declared.get(acknowledgement);
      if (!declaration || declaration.automatic || !declaration.requiresAuthority)
        throw new WatchPluginError(`Watch item ${entry.id} acknowledges through an undeclared human action`);
    }
    const controls = new Set<string>();
    for (const control of entry.actions) {
      if (controls.has(control.id)) throw new WatchPluginError(`Watch item ${entry.id} repeats action ${control.id}`);
      controls.add(control.id);
      if (!('effect' in control.binding)) continue;
      const declaration = declared.get(control.binding.effect.action);
      if (!declaration || declaration.automatic || !declaration.requiresAuthority)
        throw new WatchPluginError(`Watch item ${entry.id} binds ${control.id} to an undeclared human action`);
      pluginSchema(declaration.arguments ?? { type: 'null' }, `Watch action ${declaration.id} arguments`).parse(
        control.binding.effect.arguments ?? null,
      );
    }
  }
}

/**
 * Built-in and plugin presentations share one validation path. Pass the
 * version a plugin declared to refuse a mismatch; otherwise the value's own
 * version selects the schema.
 */
export function validateWatchPresentation(value: unknown, version?: WatchPresentationVersion): WatchPresentation {
  const declared =
    version ?? (value && typeof value === 'object' && (value as { version?: unknown }).version === 2 ? 2 : 1);
  if (declared === 1) return pluginSchema<WatchPresentation>(watchPresentationSchema, 'Watch presentation').parse(value);
  const presentation = pluginSchema<WatchPresentation>(watchPresentationSchemaV2, 'Watch presentation v2').parse(value);
  validateWatchItems(presentation);
  return presentation;
}

const descriptorSchema: PluginJsonSchema = {
  type: 'object',
  required: ['id', 'apiVersion', 'stateVersion', 'version'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9.-]*$' },
    keyPrefix: { type: 'string', pattern: '^(?:[a-z][a-z0-9.-]*:)?$' },
    apiVersion: { const: 1 },
    stateVersion: { type: 'integer', minimum: 1 },
    version: { type: 'string', minLength: 1 },
    attentionKinds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'label', 'defaultEnabled'],
        additionalProperties: false,
        properties: { kind: string, label: string, defaultEnabled: { type: 'boolean' } },
      },
    },
  },
};
const manifestSchema: PluginJsonSchema = {
  type: 'object',
  required: ['protocolVersion', 'presentationVersion', 'descriptor', 'schemas', 'bindings', 'capabilities'],
  additionalProperties: false,
  properties: {
    protocolVersion: { const: 1 },
    presentationVersion: { enum: [1, 2] },
    descriptor: descriptorSchema,
    schemas: {
      type: 'object',
      required: ['reference', 'options', 'state', 'cursor'],
      additionalProperties: false,
      properties: { reference: schema, options: schema, state: schema, cursor: schema },
    },
    bindings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event', 'field'],
        additionalProperties: false,
        properties: {
          event: { enum: ['explicit', 'report', 'turn-wait', 'local', 'legacy-command'] },
          field: string,
          pattern: string,
          importsType: string,
        },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        acknowledgements: { type: 'object', required: ['patterns'], additionalProperties: false, properties: { patterns: { type: 'array', items: { type: 'string' } } } },
        triggers: { type: 'boolean' },
        commands: { type: 'object', required: ['bindings'], additionalProperties: false, properties: {
          bindings: { type: 'array', items: { type: 'object', required: ['name'], additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1 }, pattern: { type: 'string' } } } },
        } },
        registration: { type: 'boolean' },
        batch: { type: 'boolean' },
        subscribe: { type: 'boolean' },
        automation: { type: 'boolean' },
        dispatch: { type: 'boolean' },
        derived: { type: 'boolean' },
        actions: {
          type: 'object',
          required: ['authorityRequired', 'arguments', 'result'],
          additionalProperties: false,
          properties: { authorityRequired: { const: true }, arguments: schema, result: schema },
        },
        notices: { type: 'object', required: ['kinds'], additionalProperties: false, properties: { kinds: strings, quietKinds: strings } },
      },
    },
  },
};

/** Reject a changed release or API before trusting schemas, instructions or operations. */
export function validatePluginManifest(
  value: unknown,
  expected: Pick<WatchPluginConfiguration, 'id' | 'version' | 'apiVersion'>,
): WatchPluginManifest {
  const manifest = pluginSchema<WatchPluginManifest>(manifestSchema, 'Watch plugin handshake').parse(value);
  if (
    manifest.descriptor.id !== expected.id ||
    manifest.descriptor.version !== expected.version ||
    manifest.descriptor.apiVersion !== expected.apiVersion
  )
    throw new WatchPluginError('Watch plugin identity or release differs from its configured installation');
  for (const [name, declaration] of Object.entries(manifest.schemas)) pluginSchema(declaration, `Plugin ${name} schema`);
  if (manifest.capabilities.actions) {
    pluginSchema(manifest.capabilities.actions.arguments, 'Plugin action arguments');
    pluginSchema(manifest.capabilities.actions.result, 'Plugin action result');
  }
  for (const binding of [...manifest.bindings, ...(manifest.capabilities.commands?.bindings ?? [])])
    if (binding.pattern) {
      try {
        new RegExp(binding.pattern);
      } catch {
        throw new WatchPluginError('Invalid plugin registration pattern');
      }
    }
  for (const pattern of manifest.capabilities.acknowledgements?.patterns ?? []) {
    try { new RegExp(pattern); } catch { throw new WatchPluginError('Invalid plugin acknowledgement pattern'); }
  }
  return manifest;
}

/** Configuration is validated without starting executable code. */
export function parseWatchPluginConfiguration(id: string, value: Record<string, unknown>): WatchPluginConfiguration {
  const fail = (message: string): never => {
    throw new Error(`[watchTypes.${id}].${message}`);
  };
  if (
    !Array.isArray(value.command) ||
    !value.command.length ||
    value.command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
  )
    fail('command must be a nonempty executable and argv list');
  if (typeof value.version !== 'string' || !value.version.trim()) fail('version must pin the adapter release');
  if (value.apiVersion !== undefined && value.apiVersion !== 1) fail('apiVersion must be 1');
  const envAllow = value.envAllow ?? [];
  if (!Array.isArray(envAllow) || envAllow.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    fail('envAllow must list environment variable names');
  const allowed = value.allowCapabilities ?? ['poll'];
  if (!Array.isArray(allowed) || allowed.some((capability) => !WATCH_PLUGIN_CAPABILITIES.includes(capability as WatchPluginCapability)))
    fail('allowCapabilities contains an unsupported capability');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd)) fail('cwd must be a working directory');
  const number = (name: string, fallback: number, minimum = 1, maximum = 120_000): number => {
    const candidate = value[name] ?? fallback;
    if (!Number.isSafeInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum)
      fail(`${name} must be a whole number from ${minimum} to ${maximum}`);
    return Number(candidate);
  };
  return {
    id,
    command: [...(value.command as string[])],
    version: value.version as string,
    apiVersion: 1,
    ...(value.cwd ? { cwd: value.cwd as string } : {}),
    envAllow: [...new Set(envAllow as string[])],
    allowCapabilities: [...new Set(allowed as WatchPluginCapability[])],
    startupTimeoutMs: number('startupTimeoutMs', 5000),
    requestTimeoutMs: number('requestTimeoutMs', 30_000),
    maxMessageBytes: number('maxMessageBytes', 1024 * 1024, 1024, 8 * 1024 * 1024),
    maxRestarts: number('maxRestarts', 3, 0, 100),
    restartWindowMs: number('restartWindowMs', 60_000),
    restartBackoffMs: number('restartBackoffMs', 1000, 0),
  };
}

/** Hash only installation settings; ambient credential values never become persisted identity. */
export function watchPluginIdentity(configuration: WatchPluginConfiguration): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

/** Keep just the OS launch environment and explicitly granted names. */
export function watchPluginEnvironment(allow: readonly string[], ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = new Set([
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    ...allow,
  ]);
  return Object.fromEntries(Object.entries(ambient).filter(([name, value]) => names.has(name) && value !== undefined));
}

/** Omit absent DTO fields while rejecting lossy array values, functions and nonfinite numbers. */
export function pluginDto(value: unknown): WatchValue {
  if (Array.isArray(value)) return value.map(pluginDto);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, pluginDto(entry)]),
    );
  return watchJson(value);
}

export const watchFailureSchema: PluginJsonSchema = {
  type: 'object',
  required: ['kind', 'message'],
  additionalProperties: false,
  properties: {
    kind: string,
    message: string,
    remedy: string,
    retryAfterSecs: { type: 'number', minimum: 0 },
    hold: { type: 'boolean' },
    shared: { type: 'boolean' },
    exitCode: { type: 'integer' },
  },
};
export function validateWatchFailure(value: unknown): WatchFailure {
  return pluginSchema<WatchFailure>(watchFailureSchema, 'Watch plugin failure').parse(value);
}

/** Cursor and payload values are separately checked against the adapter’s schemas. */
export const watchBatchSchema: PluginJsonSchema = {
  type: 'object',
  required: ['cursor', 'events'],
  additionalProperties: false,
  properties: {
    cursor: {},
    events: {
      type: 'array',
      maxItems: 10000,
      items: {
        type: 'object',
        required: ['id', 'kind', 'at', 'summary', 'data'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { type: 'string', minLength: 1 },
          at: { type: 'string', format: 'date-time' },
          summary: string,
          data: {},
        },
      },
    },
    done: { type: 'boolean' },
    failure: watchFailureSchema,
    deferred: { type: 'boolean' },
    payload: {},
  },
};
export const watchActionRequestSchema: PluginJsonSchema = {
  type: 'object',
  required: ['id', 'actionId', 'reference', 'expectedRevision', 'authorization', 'arguments'],
  additionalProperties: false,
  properties: {
    generation: string,
    id: { type: 'string', minLength: 1 },
    actionId: { type: 'string', minLength: 1 },
    reference: {},
    expectedRevision: { type: 'string', minLength: 1 },
    arguments: {},
    authorization: {
      type: 'object',
      required: ['id', 'by', 'at'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        by: { type: 'string', minLength: 1 },
        at: { type: 'string', format: 'date-time' },
      },
    },
  },
};
export const watchEffectResultSchema: PluginJsonSchema = {
  type: 'object',
  required: ['workIds'],
  additionalProperties: false,
  properties: { workIds: { type: 'array', items: { type: 'string', minLength: 1 } }, data: {} },
};

/** Separate transport settings from adapter-owned defaults before validating source options. */
export function watchPluginDefaults(value: Record<string, unknown>): Record<string, unknown> {
  const transport = new Set([
    'enabled',
    'module',
    'command',
    'version',
    'apiVersion',
    'cwd',
    'envAllow',
    'allowCapabilities',
    'startupTimeoutMs',
    'requestTimeoutMs',
    'maxMessageBytes',
    'maxRestarts',
    'restartWindowMs',
    'restartBackoffMs',
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !transport.has(key)));
}

/** Registration results cannot change ownership or carry executable host callbacks. */
export const watchRegistrationPlanSchema: PluginJsonSchema = {
  anyOf: [
    { type: 'null' },
    { type: 'object', required: ['input', 'options'], additionalProperties: false,
      properties: { input: { type: 'string', minLength: 1 }, options: {} } },
  ],
};

export const watchTriggerReferenceSchema: PluginJsonSchema = {
  type: 'object', required: ['key', 'on'], additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1 }, on: { type: 'string', minLength: 1 } },
};
export const watchTriggerReadingSchema: PluginJsonSchema = {
  oneOf: [
    { type: 'object', required: ['state'], additionalProperties: false, properties: { state: { enum: ['waiting', 'lost'] } } },
    { type: 'object', required: ['state', 'as'], additionalProperties: false, properties: { state: { const: 'met' }, as: { type: 'string' } } },
  ],
};
