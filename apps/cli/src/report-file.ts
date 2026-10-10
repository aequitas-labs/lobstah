import {
  briefTitle,
  displayGrounds,
  storageGrounds,
  dispatchReportKey,
  fileReport,
  followUpAncestors,
  laneOf,
  listReports,
  loadConfig,
  newHelmReportKey,
  readReport,
  readSessionClaim,
  readEvidence,
  storedDescriptor,
  trapNameForId,
} from '@lobstah/core';
import type { Lane, ReportMeta, TendAttention } from '@lobstah/core';
import { currentAck, writeAck } from './acks.js';

/**
 * The CLI half of reports (core's reports.ts stores them): who filed one,
 * the automatic ack of an older report in the same chain, the `report`
 * attention items, and the `lobstah reports` rows.
 */

/** The trap name for a dispatch a trap worked, from its claim or its delivery. */
function trapOf(id: string, lane: Lane): string | undefined {
  const by = readSessionClaim(id, lane)?.by ?? readEvidence(id, lane).deliveredTo;
  if (!by?.startsWith('wt:')) return undefined;
  const trapId = by.slice('wt:'.length);
  return trapNameForId(trapId) ?? by;
}

/**
 * `report done|failed --report <file.md> [--attach <file>]`: file the
 * dispatch's report, then ack the report of every dispatch before it in its
 * follow-up chain. Throws ReportError before anything is copied when a file
 * is refused.
 */
export function fileDispatchReport(id: string, lane: Lane, file: string, attach: string[]): ReportMeta {
  const descriptor = storedDescriptor(id, lane);
  const trap = trapOf(id, lane);
  const meta = fileReport({
    key: dispatchReportKey(id, lane),
    file,
    attach,
    fallbackTitle: descriptor ? briefTitle(descriptor.brief) : id,
    author: trap ?? 'headless',
    maxBytes: loadConfig().limits.attachmentMaxBytes,
    dispatch: id,
    lane,
    ...(trap ? { trap } : {}),
    ...(descriptor?.repo ? { repo: descriptor.repo } : {}),
  });
  for (const older of followUpAncestors(id, lane)) {
    const prev = readReport(dispatchReportKey(older, laneOf(older) ?? lane));
    if (prev && !currentAck(prev.key, prev.stateHash)) {
      writeAck({ key: prev.key, kind: 'report', stateHash: prev.stateHash, at: meta.filedAt, by: `newer report ${meta.key}` });
    }
  }
  return meta;
}

/** `man file <file.md> [--attach <file>] [--title <text>]`: a helm's own report under its grounds. */
export function fileHelmReport(grounds: string, file: string, attach: string[], title?: string): ReportMeta {
  const cfg = loadConfig();
  grounds = storageGrounds(grounds, cfg);
  return fileReport({
    key: newHelmReportKey(grounds),
    file,
    attach,
    ...(title ? { title } : {}),
    fallbackTitle: `helm report · ${displayGrounds(grounds, cfg)}`,
    author: 'helm',
    maxBytes: cfg.limits.attachmentMaxBytes,
    grounds,
  });
}

/** One `report` attention item per filed report: it stands until acked. */
export function reportAttention(now: number, reports: ReportMeta[] = listReports()): TendAttention[] {
  return reports.map((r) => ({
    kind: 'report',
    key: r.key,
    stateHash: r.stateHash,
    id: r.dispatch ?? r.key.split(':').at(-1)!,
    lane: r.lane ?? 'work',
    verb: 'report',
    ageSecs: Math.max(0, Math.round((now - Date.parse(r.filedAt)) / 1000)),
    at: r.filedAt,
    standingSince: r.filedAt,
    note: r.title,
    ...(r.repo ? { repo: r.repo } : {}),
  }));
}

/** A report and whether a human has acked this filing of it. */
export function reportAck(r: ReportMeta): { at: string; by: string } | undefined {
  const ack = currentAck(r.key, r.stateHash);
  return ack ? { at: ack.at, by: ack.by } : undefined;
}

/**
 * The human opened a report on its glass page: ack this filing, by `glass`.
 * State only: it wakes no one. An existing ack of this filing (a first view,
 * the terminal, a newer report) stands with its time; a refiled report has
 * a new stateHash, so it stands again until opened again. Undefined when no
 * report has the key.
 */
export function viewReport(key: string, now = new Date()): { key: string; viewedAt: string; by: string; first: boolean } | undefined {
  const r = readReport(key);
  if (!r) return undefined;
  const held = currentAck(r.key, r.stateHash);
  if (held) return { key: r.key, viewedAt: held.at, by: held.by, first: false };
  const ack = { key: r.key, kind: 'report', stateHash: r.stateHash, at: now.toISOString(), by: 'glass' };
  writeAck(ack);
  return { key: r.key, viewedAt: ack.at, by: ack.by, first: true };
}

/** The rows `lobstah reports` prints, newest first. */
export function reportRows(): Array<Record<string, string>> {
  const cfg = loadConfig();
  return listReports().map((r) => ({
    key: r.key,
    title: r.title,
    author: r.author,
    from: r.dispatch ?? `helm ${displayGrounds(r.grounds ?? '', cfg)}`.trim(),
    filedAt: r.filedAt,
    acked: reportAck(r) ? 'yes' : 'no',
  }));
}
