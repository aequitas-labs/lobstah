import { BaseWatchType } from '../base.js';
import type {
  WatchCloseReason,
  WatchFailure,
  WatchPlan,
  WatchObservationBatch,
  WatchPresentation,
  WatchSnapshot,
  WatchSubscriber,
  WatchEffectHandler,
} from '../model.js';
import { deploymentCursorSchema, deploymentOptionsSchema, deploymentReferenceSchema, deploymentStateSchema } from './model.js';
import type { DeploymentContext, DeploymentOptions, DeploymentProvider, DeploymentReference, DeploymentState } from './model.js';
import { FixtureDeploymentProvider } from './fixture.js';
export * from './model.js';
export * from './fixture.js';

/** Fixture-backed source policy runs unchanged in a local registry or the process host. */
export class DeploymentWatchType extends BaseWatchType<DeploymentReference, DeploymentState, number, DeploymentOptions> {
  readonly descriptor = {
    id: 'deployment', keyPrefix: 'deployment:',
    apiVersion: 1 as const,
    stateVersion: 1,
    version: '1.0.0',
    attentionKinds: [{ kind: 'deployment:failed', label: 'Deployment failed', defaultEnabled: true }],
  };
  readonly bindings = [{ event: 'explicit' as const, field: 'key', pattern: '^deployment:' }];
  readonly referenceSchema = deploymentReferenceSchema;
  readonly optionsSchema = deploymentOptionsSchema;
  readonly cursorSchema = deploymentCursorSchema;
  readonly stateSchema = deploymentStateSchema;
  readonly subscriber: WatchSubscriber<DeploymentReference, DeploymentState, number, DeploymentOptions>;
  readonly effectHandler: WatchEffectHandler<DeploymentReference>;
  constructor(readonly provider: DeploymentProvider = new FixtureDeploymentProvider()) {
    super();
    this.subscriber = { subscribe: (context) => provider.subscribe(context) };
    this.effectHandler = {
      execution: 'sync',
      execute: (request) => {
        if (request.actionId !== 'acknowledge') throw new Error('Unsupported deployment action');
        return provider.acknowledge(request);
      },
    };
  }
  identify(input: string, options: DeploymentOptions): DeploymentReference | undefined {
    const match = /^deployment:([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(input);
    return match ? { environment: match[1]!, deploymentId: match[2]!, fixturePath: options.fixturePath } : undefined;
  }
  key(reference: DeploymentReference): string {
    return `deployment:${reference.environment}/${reference.deploymentId}`;
  }
  initialize(): { state: DeploymentState; cursor: number } {
    return { state: { sequence: 0, phase: 'queued', logUrl: '', terminal: false }, cursor: 0 };
  }
  restore(snapshot: WatchSnapshot): WatchSnapshot<DeploymentReference, DeploymentState, number, DeploymentOptions> {
    if (snapshot.type.apiVersion !== 1 || snapshot.type.stateVersion !== 1) throw new Error('Unsupported deployment watch state');
    const reference = this.referenceSchema.parse(snapshot.reference),
      options = this.optionsSchema.parse(snapshot.options);
    const state = this.stateSchema.parse(snapshot.state),
      cursor = this.cursorSchema.parse(snapshot.cursor);
    if (reference.fixturePath !== options.fixturePath || state.sequence !== cursor)
      throw new Error('Deployment checkpoint does not match its reference or state');
    return { ...snapshot, reference, options, state, cursor };
  }
  poll(context: DeploymentContext): WatchObservationBatch<number> {
    return this.provider.observe(context);
  }
  reduce(
    snapshot: WatchSnapshot<DeploymentReference, DeploymentState, number, DeploymentOptions>,
    batch: WatchObservationBatch<number>,
  ): WatchPlan<DeploymentState, number> {
    // A delayed stream batch cannot move a cursor behind a more recent poll.
    if (batch.cursor <= snapshot.cursor) return { state: snapshot.state, cursor: snapshot.cursor, done: snapshot.state.terminal };
    const state = this.stateSchema.parse(batch.payload);
    if (state.sequence !== batch.cursor) throw new Error('Deployment state and cursor disagree');
    return { state, cursor: batch.cursor, done: state.terminal };
  }
  present(snapshot: WatchSnapshot<DeploymentReference, DeploymentState, number, DeploymentOptions>): WatchPresentation {
    const { reference, state } = snapshot,
      failed = state.phase === 'failed';
    const summary = `Deployment ${reference.deploymentId} ${state.phase} in ${reference.environment}`;
    return {
      title: `${reference.environment} deployment ${reference.deploymentId}`,
      summary,
      label: 'Deployment',
      tone: failed ? 'risk' : state.phase === 'succeeded' ? 'ok' : 'neutral',
      worker: {
        steps: [
          ...(state.logUrl ? [`Read the deployment logs at ${state.logUrl}.`] : ['Wait for the deployment result.']),
          'Investigate the recorded deployment result and report the outcome to its owner.',
        ],
      },
      helm: {
        steps: [
          'Keep deployment feedback with its owning worker or chain.',
          'Record human authority before acknowledging the deployment result.',
        ],
      },
      rows: [
        { label: 'Environment', value: reference.environment },
        { label: 'Status', value: state.phase },
        { label: 'Revision', value: String(state.sequence) },
      ],
      links: state.logUrl ? [{ label: 'Open deployment logs', url: state.logUrl }] : [],
      actions: failed ? [{ id: 'acknowledge', label: 'Acknowledge failure', requiresAuthority: true }] : [],
      attention: failed
        ? [
            {
              id: 'failure',
              kind: 'deployment:failed',
              stateHash: `${snapshot.key}:${state.sequence}`,
              summary,
              quiet: false,
              blocking: true,
            },
          ]
        : [],
    };
  }
  failure(error: unknown): WatchFailure {
    return {
      kind: 'deployment',
      message: error instanceof Error ? error.message : String(error),
      remedy: 'Correct the deployment fixture or restore access, then retry.',
    };
  }
  async close(context: DeploymentContext, _reason: WatchCloseReason): Promise<void> {
    await this.provider.close(context);
  }
}
