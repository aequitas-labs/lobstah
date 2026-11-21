import { execFile } from 'node:child_process';
import { UME_REVIEW_SOURCE } from '@lobstah/core';
import type { ReviewRequestItem, UmeConfig, UmeReviews } from '@lobstah/core';

/**
 * ume review requests for the glass's Reviews page, read straight from the
 * `ume` CLI each time the page asks: no daemon watch, no stored state. For
 * each configured project it lists the artifacts in review, then reads the
 * project's activity to find the ones whose review was requested from you
 * and that you have not answered since.
 */

/** One `ume` call's answer: its parsed JSON, or why it failed. `missing` means the CLI is not installed. */
export type UmeRun = { ok: true; json: unknown } | { ok: false; missing?: boolean; reason: string };

/** Runs `ume <args> --json`, in one project when `project` is given. Tests pass a fake. */
export type UmeRunner = (args: string[], project?: string) => Promise<UmeRun>;

/** How long one `ume` call may take before its project counts as failed. */
const UME_TIMEOUT_MS = 20_000;

/** The ume CLI on PATH, with JSON output and no browser. */
export const runUme: UmeRunner = (args, project) =>
  new Promise((resolve) => {
    const env = { ...process.env, UME_NO_BROWSER: '1', ...(project ? { UME_PROJECT: project } : {}) };
    execFile('ume', [...args, '--json'], { env, timeout: UME_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ ok: false, missing: true, reason: 'ume is not installed' });
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      const refused = json && typeof json === 'object' && (json as { ok?: unknown }).ok === false;
      if (!error && json !== undefined && !refused) return resolve({ ok: true, json });
      resolve({ ok: false, reason: umeReason(json, stderr, error) });
    });
  });

/** ume's own words for a failure: its JSON `error`, else stderr's first line, without the `ume:` prefix. */
function umeReason(json: unknown, stderr: string, error: Error | null): string {
  const said = json && typeof json === 'object' ? (json as { error?: unknown }).error : undefined;
  const line =
    (typeof said === 'string' && said) ||
    stderr.split('\n').find((l) => l.trim()) ||
    ((error as { killed?: boolean } | null)?.killed ? 'ume did not answer in time' : error?.message) ||
    'ume answered something it could not read';
  const text = line.replace(/^ume:\s*/, '').trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

interface UmeArtifact {
  id: string;
  title: string;
  kind?: string;
  rev?: number;
  approval?: string;
  sets?: string;
  archived?: unknown;
}

interface UmeTouchpoint {
  at: string;
  kind: string;
  actor?: string;
  by?: string;
  artifact?: string;
  to?: string;
}

interface UmePerson {
  id: string;
  name?: string;
  email?: string;
}

const rows = <T>(json: unknown, key: string): T[] => {
  const list = json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? (list as T[]) : [];
};

/** An artifact id the ume link takes as is. */
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The role the artifact has in its first set ("plan"), else ume's kind ("doc"). */
function artifactKind(a: UmeArtifact): string {
  const role = a.sets
    ?.split(',')
    .map((entry) => entry.split(':')[1]?.trim())
    .find(Boolean);
  return role || a.kind || 'artifact';
}

/** One ume artifact waiting on your review, as a review item. */
export function umeReviewRequestItem(
  a: UmeArtifact,
  request: UmeTouchpoint,
  opts: { projectName: string; requester?: UmePerson },
): ReviewRequestItem {
  const href = `https://app.ume.so/a/${a.id}`;
  const name = opts.requester?.name || opts.requester?.email || request.actor || 'someone';
  const who = request.by === 'agent' ? `${name}’s agent` : name;
  const kind = artifactKind(a);
  return {
    id: `ume:${a.id}`,
    source: UME_REVIEW_SOURCE,
    title: a.title,
    kind,
    glyph: { kind: 'document' },
    lifecycle: { phase: 'active', label: 'In review' },
    statuses: [],
    attention: 'needs-you',
    person: { id: request.actor ?? name, name: who, role: 'requested by' },
    context: [
      { kind: 'text', value: opts.projectName },
      { kind: 'text', value: kind },
      ...(typeof a.rev === 'number' ? [{ kind: 'revision' as const, value: `revision ${a.rev}` }] : []),
      { kind: 'text', value: `asked by ${who}` },
      { kind: 'time', value: request.at },
    ],
    requestedAt: request.at,
    target: href,
    actions: [{ label: 'Open in ume', href, placement: 'primary' }],
  };
}

/**
 * The artifacts in review that wait on `person`: the newest review request
 * sent to them, with no verdict from them after it. An artifact whose
 * request is older than the activity read is left out, since nothing says
 * who it waits on.
 */
export function waitingOn(artifacts: readonly UmeArtifact[], touchpoints: readonly UmeTouchpoint[], person: string): Array<{ artifact: UmeArtifact; request: UmeTouchpoint }> {
  const out: Array<{ artifact: UmeArtifact; request: UmeTouchpoint }> = [];
  for (const artifact of artifacts) {
    if (artifact.approval !== 'in-review' || artifact.archived || !ARTIFACT_ID.test(artifact.id)) continue;
    const mine = touchpoints.filter((t) => t.artifact === artifact.id);
    const request = mine
      .filter((t) => t.kind === 'review.requested' && t.to === person)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!request) continue;
    if (mine.some((t) => t.kind === 'verdict.cast' && t.actor === person && t.at > request.at)) continue;
    out.push({ artifact, request });
  }
  return out;
}

/** Read every configured project's review requests. A project that fails names itself in `problems`; the rest still show. */
export async function readUmeReviews(cfg: UmeConfig, run: UmeRunner = runUme): Promise<UmeReviews> {
  if (!cfg.projects.length) return { configured: false, items: [], problems: [] };
  const listed = await Promise.all(
    cfg.projects.map(async (project) => ({ project, answer: await run(['artifacts', '--fields', 'id,title,kind,rev,approval,sets,archived'], project) })),
  );
  if (listed.some(({ answer }) => !answer.ok && answer.missing)) return { configured: true, items: [], missing: true, problems: [] };
  const problems: UmeReviews['problems'] = [];
  const inReview: Array<{ project: string; artifacts: UmeArtifact[] }> = [];
  for (const { project, answer } of listed) {
    if (!answer.ok) problems.push({ project, reason: answer.reason });
    else {
      const artifacts = rows<UmeArtifact>(answer.json, 'artifacts').filter((a) => a.approval === 'in-review' && !a.archived);
      if (artifacts.length) inReview.push({ project, artifacts });
    }
  }
  if (!inReview.length) return { configured: true, items: [], problems };
  // Only projects with something in review need their activity, people, and the viewer's id.
  const [names, self, details] = await Promise.all([
    run(['projects']),
    cfg.person ? Promise.resolve(undefined) : run(['whoami']),
    Promise.all(
      inReview.map(async ({ project, artifacts }) => ({
        project,
        artifacts,
        activity: await run(['activity', '--limit', '500', '--fields', 'at,kind,actor,by,artifact,to'], project),
        people: await run(['people'], project),
      })),
    ),
  ]);
  const projectName = new Map(
    names.ok ? rows<{ project: string; name?: string }>(names.json, 'projects').map((p) => [p.project, p.name || p.project]) : [],
  );
  const whoami = self?.ok ? (self.json as { user?: unknown }).user : undefined;
  if (!cfg.person && typeof whoami !== 'string') {
    for (const { project } of details) problems.push({ project, reason: self && !self.ok ? self.reason : 'ume did not say who you are' });
    return { configured: true, items: [], problems };
  }
  const items: ReviewRequestItem[] = [];
  for (const { project, artifacts, activity, people } of details) {
    if (!activity.ok) {
      problems.push({ project, reason: activity.reason });
      continue;
    }
    const persons = people.ok ? rows<UmePerson>(people.json, 'people') : [];
    const wanted = cfg.person ?? (whoami as string);
    const person = wanted.includes('@') ? persons.find((p) => p.email?.toLowerCase() === wanted.toLowerCase())?.id : wanted;
    if (!person) {
      problems.push({ project, reason: `${wanted} is not a member of this project` });
      continue;
    }
    for (const { artifact, request } of waitingOn(artifacts, rows<UmeTouchpoint>(activity.json, 'touchpoints'), person))
      items.push(
        umeReviewRequestItem(artifact, request, {
          projectName: projectName.get(project) ?? project,
          requester: persons.find((p) => p.id === request.actor),
        }),
      );
  }
  items.sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));
  return { configured: true, items, problems };
}
