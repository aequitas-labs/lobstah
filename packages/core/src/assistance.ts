import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath, readDirIfPresent } from './paths.js';
import { loadConfig } from './config.js';
import { cancelQueued, cancelRequested, requestCancel, storedDescriptor } from './queue.js';
import { laneOf } from './worktrees.js';
import { readStatusLog } from './status.js';
import { sendMessageOnce } from './inbox.js';
import { dispatchReportKey, readReport, reportMarkdownPath } from './reports.js';
import { postNotice } from './notices.js';
import type { Descriptor, Lane } from './types.js';

/** A durable child-result outbox; retries retain the same inbox delivery identity. */
export interface AssistanceDelivery {
  child: string;
  childLane: Lane;
  parent: string;
  parentLane: Lane;
  grounds: string;
  state: 'waiting' | 'sent' | 'retained';
  deliveryId: string;
}

function assistanceDirectory(): string { return path.join(lobstahHome(), 'assistance'); }
function saveAssistanceDelivery(delivery: AssistanceDelivery): void {
  fs.mkdirSync(assistanceDirectory(), { recursive: true });
  const file = path.join(assistanceDirectory(), `${delivery.child}.json`), temporary = uniqueTempPath(file);
  fs.writeFileSync(temporary, JSON.stringify(delivery)); atomicRenameSync(temporary, file);
}

/** A parent must still be open and belong to the configured profile's own grounds. */
export function validateAssistanceParent(descriptor: Descriptor): { id: string; lane: Lane } | undefined {
  const target = descriptor.target, parent = target?.parentDispatch;
  if (!parent) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(parent) || parent === descriptor.id) throw new Error('invalid assistance parent');
  const lane = laneOf(parent), origin = lane ? storedDescriptor(parent, lane) : undefined;
  if (!lane || !origin) throw new Error(`assistance parent ${parent} does not exist`);
  const config = loadConfig(), groundsRepos = config.grounds[target.grounds]?.repos ?? (target.grounds === 'fleet' && Object.keys(config.grounds).length === 0 ? Object.keys(config.repos) : []);
  if (origin.target ? origin.target.grounds !== target.grounds : !origin.repo || !groundsRepos.includes(origin.repo)) throw new Error('assistance parent belongs to another grounds');
  if (parentEnded(parent, lane)) throw new Error('assistance parent has already ended');
  return { id: parent, lane };
}

/** Record the relation before publishing queued assistance; no general send privilege is granted. */
export function stageAssistance(descriptor: Descriptor, lane: Lane): void {
  const parent = validateAssistanceParent(descriptor);
  if (!parent) return;
  saveAssistanceDelivery({ child: descriptor.id, childLane: lane, parent: parent.id, parentLane: parent.lane, grounds: descriptor.target!.grounds, state: 'waiting', deliveryId: `assistance-${createHash('sha256').update(descriptor.id).digest('hex')}` });
}

/** Cancellation and terminal reports end a parent without reopening it for late child results. */
function parentEnded(id: string, lane: Lane): boolean {
  return cancelRequested(id, lane) || ['done', 'failed'].includes(readStatusLog(id, lane).at(-1)?.verb ?? '');
}

let reconcilingAssistance = false;

/** Replay pending outboxes without allowing one pending filesystem write to fail unrelated reports. */
export function reconcileAssistance(): void {
  if (reconcilingAssistance) return;
  reconcilingAssistance = true;
  try {
  for (const file of readDirIfPresent(assistanceDirectory()).filter((name) => name.endsWith('.json'))) {
    try {
    const delivery = JSON.parse(fs.readFileSync(path.join(assistanceDirectory(), file), 'utf8')) as AssistanceDelivery;
    if (delivery.state !== 'waiting') continue;
    const child = storedDescriptor(delivery.child, delivery.childLane);
    if (!child) continue;
    const last = readStatusLog(delivery.child, delivery.childLane).at(-1);
    const ended = parentEnded(delivery.parent, delivery.parentLane);
    if (!last || !['done', 'failed'].includes(last.verb)) {
      if (ended) {
        if (cancelQueued(delivery.child, delivery.childLane)) saveAssistanceDelivery({ ...delivery, state: 'retained' });
        else if (!cancelRequested(delivery.child, delivery.childLane)) requestCancel(delivery.child, delivery.childLane);
      }
      continue;
    }
    if (ended) {
      postNotice({ kind: 'assistance-result', grounds: delivery.grounds, refId: delivery.child, text: `Assistance ${delivery.child} ${last.verb}: ${last.note ?? ''}. Parent ${delivery.parent} has ended; its result is retained.`, dedupeKey: delivery.deliveryId });
      saveAssistanceDelivery({ ...delivery, state: 'retained' });
      continue;
    }
    const reportKey = dispatchReportKey(delivery.child, delivery.childLane), report = readReport(reportKey), markdown = reportMarkdownPath(reportKey);
    sendMessageOnce(delivery.parent, delivery.parentLane, delivery.deliveryId,
      `Assistance ${delivery.child} ${last.verb}: ${last.note ?? ''}${markdown ? `\nFindings: ${markdown}` : ''}\nContinue the original dispatch; it keeps ownership of repo changes and the PR.`,
      `dispatch:${delivery.child}`, report?.attachments ?? []);
    saveAssistanceDelivery({ ...delivery, state: 'sent' });
    } catch (error) {
      try { postNotice({ kind: 'assistance-result', refId: file.slice(0, -5), text: `Assistance result delivery is pending for ${file.slice(0, -5)}; it will retry: ${error instanceof Error ? error.message : String(error)}`, dedupeKey: `assistance-retry-${file}` }); } catch { /* The outbox remains waiting if storage itself is unavailable. */ }
    }
  }
  } finally { reconcilingAssistance = false; }
}
