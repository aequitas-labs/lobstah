import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { WatchActionRequest, WatchEffectResult, WatchObservationBatch } from '../model.js';
import { pluginSchema } from '../plugin-model.js';
import { deploymentActionSchemas, deploymentHistorySchema } from './model.js';
import type { DeploymentContext, DeploymentProvider, DeploymentReference, DeploymentTransition } from './model.js';

interface ActiveDeploymentStream {
  controller: AbortController;
  finished: Promise<void>;
  finish(): void;
}
/** Fixture artifacts are scoped to source identity, generation and recorded request IDs. */
export function deploymentFixtureFiles(
  reference: DeploymentReference,
  generation: string,
): { stream: string; closed: string; action(requestId: string): string } {
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
  const prefix = `${reference.fixturePath}.${hash(`${reference.environment}/${reference.deploymentId}`)}.${hash(generation)}`;
  return {
    stream: `${prefix}.stream.json`,
    closed: `${prefix}.closed.json`,
    action: (requestId) => `${reference.fixturePath}.${hash(requestId)}.ack.json`,
  };
}

/** A deterministic local provider proves the extension boundary without contacting a deployment service. */
export class FixtureDeploymentProvider implements DeploymentProvider {
  private readonly streams = new Map<string, ActiveDeploymentStream>();
  get activeSubscriptions(): number {
    return this.streams.size;
  }

  private history(reference: DeploymentReference): DeploymentTransition[] {
    const records = deploymentHistorySchema
      .parse(JSON.parse(fs.readFileSync(reference.fixturePath, 'utf8')))
      .filter((record) => record.environment === reference.environment && record.deploymentId === reference.deploymentId);
    for (let index = 0; index < records.length; index++)
      if (records[index]!.sequence < 1 || (index > 0 && records[index]!.sequence <= records[index - 1]!.sequence))
        throw new Error('Deployment fixture sequences must increase');
    return records;
  }
  observe(context: DeploymentContext): WatchObservationBatch<number> {
    const records = this.history(context.snapshot.reference).filter((record) => record.sequence > context.snapshot.cursor);
    const latest = records.at(-1);
    return {
      cursor: latest?.sequence ?? context.snapshot.cursor,
      events: records.map((record) => ({
        id: `${record.environment}/${record.deploymentId}:${record.sequence}`,
        kind: record.phase === 'failed' ? 'deployment:failed' : 'deployment:status',
        at: record.at,
        summary: `Deployment ${record.deploymentId} ${record.phase} in ${record.environment}`,
        data: { sequence: record.sequence, phase: record.phase, logUrl: record.logUrl, terminal: record.terminal },
      })),
      ...(latest
        ? {
            payload: { sequence: latest.sequence, phase: latest.phase, logUrl: latest.logUrl, terminal: latest.terminal },
            done: latest.terminal,
          }
        : {}),
    };
  }

  async *subscribe(context: DeploymentContext): AsyncIterable<WatchObservationBatch<number>> {
    const generation = context.snapshot.generation,
      controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const files = deploymentFixtureFiles(context.snapshot.reference, generation);
    const abort = (): void => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    this.streams.set(generation, { controller, finished, finish });
    fs.writeFileSync(files.stream, JSON.stringify({ active: true, generation }));
    let snapshot = structuredClone(context.snapshot);
    try {
      while (!controller.signal.aborted) {
        const batch = this.observe({ ...context, snapshot });
        if (batch.events.length) {
          yield batch;
          snapshot = { ...snapshot, cursor: batch.cursor };
        }
        if (batch.done) return;
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, context.snapshot.options.subscribeEveryMs ?? 25);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      context.signal?.removeEventListener('abort', abort);
      fs.writeFileSync(files.stream, JSON.stringify({ active: false, generation }));
      this.streams.delete(generation);
      finish();
    }
  }

  acknowledge(request: WatchActionRequest<DeploymentReference>): WatchEffectResult {
    const args = pluginSchema<{ note: string }>(deploymentActionSchemas.arguments, 'Deployment acknowledgment').parse(request.arguments);
    const file = deploymentFixtureFiles(request.reference, request.generation ?? request.id).action(request.id);
    // The provider receipt recovers the same result even after a host crash before its own receipt commits.
    if (fs.existsSync(file)) {
      const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isDeepStrictEqual(recorded.request, request)) throw new Error('Deployment acknowledgment replay changed its scope');
      return recorded.result as WatchEffectResult;
    }
    const latest = this.history(request.reference).at(-1);
    if (!latest || String(latest.sequence) !== request.expectedRevision) throw new Error('Deployment changed before acknowledgment');
    const result: WatchEffectResult = { workIds: [], data: { acknowledged: true, requestId: request.id } };
    fs.writeFileSync(file, JSON.stringify({ request, note: args.note, result }), { flag: 'wx', mode: 0o600 });
    return result;
  }

  async close(context: DeploymentContext): Promise<void> {
    const stream = this.streams.get(context.snapshot.generation);
    if (stream) {
      stream.controller.abort();
      await stream.finished;
    }
    const file = deploymentFixtureFiles(context.snapshot.reference, context.snapshot.generation).closed;
    try {
      fs.writeFileSync(file, JSON.stringify({ key: context.snapshot.key, generation: context.snapshot.generation }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
