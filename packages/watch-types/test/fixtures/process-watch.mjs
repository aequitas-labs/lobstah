import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommandWatchType, serveWatchPlugin } from '../../dist/index.js';

/** One deterministic adapter drives both in-process and stdio conformance histories. */
export class FixtureProcessWatch extends CommandWatchType {
  descriptor = { id: 'fixture', apiVersion: 1, stateVersion: 1, version: '1.0.0', attentionKinds: [{ kind: 'fixture:approval', label: 'Fixture approval', defaultEnabled: true }] };
  bindings = [{ event: 'explicit', field: 'key', pattern: '^fixture:' }];
  optionsSchema = {
    json: { type: 'object', required: ['history'], additionalProperties: false, properties: { history: { type: 'string' }, cursor: { type: 'string' } } },
    parse(value) { if (!value || typeof value.history !== 'string') throw new Error('A fixture history is required'); return { history: value.history, ...(value.cursor === undefined ? {} : { cursor: String(value.cursor) }) }; },
  };
  stateSchema = { json: { type: 'object', required: ['phase'], additionalProperties: false, properties: { phase: { type: 'string' } } }, parse(value) { if (!value || typeof value.phase !== 'string') throw new Error('Invalid fixture phase'); return { phase: value.phase }; } };
  initialize(_reference, options) { return { state: { phase: 'waiting' }, cursor: options.cursor ?? '0' }; }
  identify(input) { return input.startsWith('fixture:') ? { key: input } : undefined; }
  restore(snapshot) {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Unsupported fixture state');
    return { ...snapshot, reference: this.referenceSchema.parse(snapshot.reference), options: this.optionsSchema.parse(snapshot.options), state: this.stateSchema.parse(snapshot.state), cursor: this.cursorSchema.parse(snapshot.cursor) };
  }
  async poll({ snapshot }) {
    const history = JSON.parse(fs.readFileSync(snapshot.options.history, 'utf8'));
    if (history.mode === 'crash') process.exit(23);
    if (history.mode === 'stdout') process.stdout.write('not a protocol frame\n');
    if (history.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 10_000));
    if (history.mode === 'auth') throw new Error('Provider credential expired');
    if (history.mode === 'malformed') return { cursor: '99', events: 'not an array' };
    if (history.envReport) fs.writeFileSync(history.envReport, JSON.stringify({ allowed: process.env.PLUGIN_ALLOWED ?? null, blocked: process.env.PLUGIN_UNDECLARED ?? null, home: process.env.LOBSTAH_HOME ?? null }));
    return { cursor: String(history.cursor), events: history.events ?? [], ...(history.done ? { done: true } : {}), payload: { phase: history.phase ?? 'waiting' } };
  }
  reduce(snapshot, batch) { return { state: batch.payload ?? snapshot.state, cursor: batch.cursor, done: batch.done === true }; }
  present(snapshot) {
    return { title: 'Fixture watch', summary: snapshot.state.phase, label: 'Fixture', tone: snapshot.state.phase === 'failed' ? 'risk' : 'neutral',
      worker: { steps: ['Read the recorded fixture feedback and report the outcome.'], read: { executable: 'fixture', args: ['feedback', snapshot.reference.key], environment: { FIXTURE_PROJECT: 'recorded' } } },
      helm: { steps: ['Keep the fixture result with its owning chain.'] }, rows: [{ label: 'Phase', value: snapshot.state.phase }], links: [{ label: 'Open fixture', url: 'https://example.test/fixture' }],
      actions: [{ id: 'acknowledge', label: 'Acknowledge fixture', requiresAuthority: true }], attention: snapshot.state.phase === 'failed' ? [{ id: 'approval', kind: 'fixture:approval', stateHash: 'failed:1', summary: 'Review fixture failure', quiet: false, blocking: true }] : [] };
  }
  failure(error) { const message = error instanceof Error ? error.message : String(error); return { kind: message.includes('credential') ? 'auth' : 'fixture', message, remedy: 'Restore fixture access and retry.' }; }
  close(context) { const history = JSON.parse(fs.readFileSync(context.snapshot.options.history, 'utf8')); if (history.cleanup) fs.appendFileSync(history.cleanup, context.snapshot.key + '\n'); }
  batchObserver = { group: ({ snapshot }) => snapshot.options.history, pollBatch: async (contexts) => Object.fromEntries(await Promise.all(contexts.map(async (context) => [context.snapshot.key, await this.poll(context)]))) };
  subscriber = { subscribe: async function* (context) {
    const history = JSON.parse(fs.readFileSync(context.snapshot.options.history, 'utf8'));
    for (const batch of history.stream ?? []) { if (context.signal?.aborted) return; yield batch; }
  } };
  effectHandler = { execution: 'sync', execute(request) { fs.writeFileSync(request.arguments.output, JSON.stringify(request)); return { workIds: [request.id], ...(request.arguments.includeData ? { data: { acknowledged: true } } : {}) }; } };
  dispatchPolicy = { plan: ({ events }) => ({ disposition: 'continue', eventIds: events.map((event) => event.id), notes: [] }), prepareBrief: (_context, filled) => filled + '\nRead the fixture feedback.', delivered() {} };
  automation = { propose: () => [] };
  derived = { views: () => [] };
  noticePolicy = { kinds: ['fixture:notice'], quietKinds: ['fixture:quiet'], current: (notice) => notice.stateHash === 'current', relatedDispatches: () => [] };
}
export const fixtureActionSchemas = { arguments: { type: 'object', required: ['output'], additionalProperties: false, properties: { output: { type: 'string' }, includeData: { type: 'boolean' } } }, result: { type: 'object', required: ['workIds'], additionalProperties: false, properties: { workIds: { type: 'array', items: { type: 'string' } }, data: {} } } };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const adapter = new FixtureProcessWatch();
  if (process.argv.includes('--release-2')) adapter.descriptor.version = '2.0.0';
  if (process.argv.includes('--api-2')) adapter.descriptor.apiVersion = 2;
  await serveWatchPlugin(adapter, { actionSchemas: fixtureActionSchemas });
}
