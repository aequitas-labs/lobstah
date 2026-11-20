import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommandWatchType, serveWatchPlugin } from '../../dist/index.js';

/**
 * A third review source as an opt-in process plugin, using only the fields
 * built-ins use: presentation v2 with a brand, a watch glyph and review
 * items in each lifecycle phase, and one authorized action. The host keeps
 * the colors, edges and layout; the plugin fills slots.
 */
const item = (id, phase, label, over = {}) => ({
  id,
  revision: 'r1',
  title: `Fixture ${label.toLowerCase()} review`,
  kind: 'document',
  glyph: { kind: 'document', variants: { completed: 'document-check' } },
  lifecycle: { phase, label },
  statuses: [{ code: 'requested', label: 'review requested', category: 'workflow', meaning: 'pending' }],
  attention: phase === 'active' ? 'needs-you' : 'none',
  notification: { revision: `${id}@r1`, unread: phase === 'active', action: 'acknowledge' },
  standing: phase === 'active',
  person: { id: 'dana', name: 'Dana', role: 'requested by' },
  metadata: [{ kind: 'project', value: 'fixture' }, { kind: 'time', value: '2026-11-19T10:00:00.000Z' }, { kind: 'reference', value: `FX-${id}` }],
  requestedAt: '2026-11-19T10:00:00.000Z',
  target: { href: `https://fixture.example.test/${id}` },
  actions: [
    ...(phase === 'active'
      ? [{ id: 'approve', label: 'Approve', glyph: 'approve', placement: 'primary', enabled: true, progress: 'Approving…', done: 'Approved', binding: { effect: { action: 'approve', arguments: { verdict: 'approve' } } } }]
      : []),
    { id: 'open', label: 'Open', placement: 'open', enabled: true, acknowledges: true, binding: { link: { href: `https://fixture.example.test/${id}` } } },
  ],
  surfaces: { list: ['reviews'], home: 'reviews' },
  ...over,
});

export class FixtureReviewPlugin extends CommandWatchType {
  descriptor = { id: 'fixture-reviews', apiVersion: 1, stateVersion: 1, version: '1.0.0' };
  bindings = [{ event: 'explicit', field: 'key', pattern: '^fixture-reviews:' }];
  optionsSchema = {
    json: { type: 'object', required: ['history'], additionalProperties: false, properties: { history: { type: 'string' } } },
    parse(value) {
      if (!value || typeof value.history !== 'string') throw new Error('A fixture history is required');
      return { history: value.history };
    },
  };
  stateSchema = { json: { type: 'object' }, parse: (value) => (value && typeof value === 'object' ? value : { items: [] }) };
  initialize() {
    return { state: { items: [] }, cursor: '0' };
  }
  identify(input) {
    return input.startsWith('fixture-reviews:') ? { key: input } : undefined;
  }
  restore(snapshot) {
    return { ...snapshot, reference: this.referenceSchema.parse(snapshot.reference), options: this.optionsSchema.parse(snapshot.options), state: this.stateSchema.parse(snapshot.state), cursor: this.cursorSchema.parse(snapshot.cursor) };
  }
  poll({ snapshot }) {
    const history = JSON.parse(fs.readFileSync(snapshot.options.history, 'utf8'));
    if (history.mode === 'fail') throw new Error('Fixture provider is down');
    return { cursor: String(history.cursor ?? 1), events: [], payload: { phases: history.phases ?? ['active', 'completed', 'closed', 'archived'] } };
  }
  reduce(snapshot, batch) {
    return { state: batch.payload ?? snapshot.state, cursor: batch.cursor, done: false };
  }
  present(snapshot) {
    const phases = snapshot.state.phases ?? [];
    const items = phases.map((phase) =>
      phase === 'archived'
        ? item('archived', 'completed', 'Approved', { lifecycle: { phase: 'completed', label: 'Approved', archived: true } })
        : item(phase, phase, { active: 'Active', completed: 'Approved', closed: 'Withdrawn', draft: 'Draft' }[phase] ?? 'Active'),
    );
    return {
      version: 2,
      source: { id: 'fixture-reviews', name: 'Fixture reviews', icon: { glyph: 'source' } },
      surfaces: ['reviews'],
      glyph: 'bell',
      items,
      title: 'Fixture reviews',
      summary: `${items.length} fixture reviews`,
      label: 'Fixture reviews',
      tone: 'neutral',
      worker: { steps: ['Fixture reviews are approved by a person.'] },
      helm: { steps: ['Point the person at the fixture card.'] },
      rows: [],
      links: [{ label: 'Open fixture reviews', url: 'https://fixture.example.test/' }],
      actions: [
        { id: 'approve', label: 'Approve', requiresAuthority: true, arguments: { type: 'object', required: ['verdict'], additionalProperties: false, properties: { verdict: { const: 'approve' } } } },
        { id: 'acknowledge', label: 'Mark seen', requiresAuthority: true },
      ],
      attention: [],
    };
  }
  failure(error) {
    return { kind: 'fixture', message: error instanceof Error ? error.message : String(error), remedy: 'Bring the fixture provider back.', retryAfterSecs: 60 };
  }
  effectHandler = {
    execution: 'sync',
    execute(request) {
      fs.appendFileSync(process.env.FIXTURE_EFFECTS ?? '/dev/null', JSON.stringify({ action: request.actionId, arguments: request.arguments, by: request.authorization.by }) + '\n');
      return { workIds: [] };
    },
  };
}

export const reviewPluginActionSchemas = {
  arguments: { type: 'object', required: ['item'], properties: { item: { type: 'string' }, values: {} } },
  result: { type: 'object', required: ['workIds'], properties: { workIds: { type: 'array', items: { type: 'string' } }, data: {} } },
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  await serveWatchPlugin(new FixtureReviewPlugin(), { presentationVersion: 2, actionSchemas: reviewPluginActionSchemas });
