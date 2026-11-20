import fs from 'node:fs';
import path from 'node:path';
import { UmeReviewWatchType, UME_PROJECT_ID, UME_REVIEW_SEEN, umeEpisodeKey, umeReviewItemId } from '@lobstah/watch-types/ume';
import type { UmeReviewEpisode, UmeReviewReference, UmeReviewRequest, UmeReviewState } from '@lobstah/watch-types/ume';
import type { WatchFailure, WatchRegistrationPolicy, WatchRegistry } from '@lobstah/watch-types';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { loadConfig } from './config.js';
import { readUme } from './ume-watch-source.js';
import type { UmeRead } from './ume-watch-source.js';
import { WatchJournal } from './watch-journal.js';
import { WatchRuntime } from './watch-runtime.js';

/**
 * The incoming ume review source's services: read one configured
 * project's approval requests as the stored ume token's person sees them,
 * remember which request episode the reviewer last opened, and keep one
 * watch per configured project registered for the home helm.
 */

/** Projects come only from `[watchTypes.ume-reviews].projects`; the worktree's attached set or ambient project never counts. */
export function configuredUmeReviewProjects(): string[] {
  const settings = loadConfig().watchTypes?.['ume-reviews'];
  if (!settings || settings.enabled === false || !Array.isArray(settings.projects)) return [];
  return [...new Set(settings.projects.filter((project): project is string => typeof project === 'string' && UME_PROJECT_ID.test(project)))];
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ume returned an incomplete listing');
  return value as Record<string, unknown>;
};

/**
 * Read the project's pending approval requests and hydrate each artifact.
 * Throws unless every listing is complete, so a failed or partial read
 * keeps the last good items instead of removing them.
 */
export function readUmeReviews(project: string, read: UmeRead = readUme): UmeReviewState {
  // ume runs outside any repo, with the project named explicitly.
  const cwd = lobstahHome();
  const whoami = object(read(['whoami', '--json'], cwd, project));
  const reviewer = typeof whoami.user === 'string' && whoami.user ? whoami.user : undefined;
  if (!reviewer) throw new Error('ume did not say whose reviews these are');
  const listing = object(read(['needs', '--kind', 'approval', '--full', '--json'], cwd, project));
  const needs = listing.needs;
  if (!Array.isArray(needs) || listing.needCount !== needs.length) throw new Error('ume returned an incomplete needs listing');
  const library = object(read(['artifacts', '--full', '--json'], cwd, project));
  const artifacts = library.artifacts;
  if (!Array.isArray(artifacts) || (typeof library.artifactCount === 'number' && library.artifactCount !== artifacts.length))
    throw new Error('ume returned an incomplete artifact listing');
  const byId = new Map(artifacts.map((artifact) => [String(object(artifact).id), object(artifact)]));
  let names = new Map<string, string>();
  try {
    const people = object(read(['people', '--json'], cwd, project)).people;
    if (Array.isArray(people)) names = new Map(people.map((person) => [String(object(person).id), String(object(person).name ?? '')]));
  } catch {
    // Names are optional; the card falls back to the person's ID.
  }
  let projectName: string | null = null;
  try {
    const projects = object(read(['projects', '--json'], cwd, project)).projects;
    if (Array.isArray(projects)) projectName = (projects.map(object).find((entry) => entry.project === project)?.name as string | undefined) ?? null;
  } catch {
    // The project ID stands in for its name.
  }
  const requests = new Map<string, UmeReviewRequest>();
  for (const value of needs) {
    const need = object(value);
    // Only formal approval requests make review items; replies, mentions and updates never do.
    if (need.kind !== 'approval') continue;
    const artifact = need.artifact;
    if (typeof artifact !== 'string' || !artifact || typeof need.ref !== 'string' || typeof need.since !== 'string')
      throw new Error('ume returned a need without its artifact or request');
    const episode: UmeReviewEpisode = { ref: need.ref, since: need.since };
    const existing = requests.get(artifact);
    if (existing) {
      if (!existing.episodes.some((entry) => umeEpisodeKey(entry) === umeEpisodeKey(episode))) existing.episodes.push(episode);
      continue;
    }
    const hydrated = byId.get(artifact);
    const owner = typeof need.owner === 'string' && need.owner ? need.owner : typeof hydrated?.owner === 'string' ? hydrated.owner : undefined;
    const role = typeof hydrated?.sets === 'string' ? /:(\w+)/.exec(hydrated.sets)?.[1] : undefined;
    requests.set(artifact, {
      artifact,
      title: typeof hydrated?.title === 'string' ? hydrated.title : String(need.title ?? artifact),
      url: typeof hydrated?.url === 'string' ? hydrated.url : String(need.url ?? ''),
      episodes: [episode],
      ...(owner ? { owner: { id: owner, ...(names.get(owner) ? { name: names.get(owner) } : {}) } } : {}),
      ...(typeof hydrated?.rev === 'number' ? { revision: hydrated.rev } : {}),
      ...(role ? { role } : {}),
      ...(hydrated ? {} : { unavailable: 'You can no longer read this artifact in ume.' }),
    });
  }
  for (const request of requests.values()) request.episodes.sort((a, b) => b.since.localeCompare(a.since) || b.ref.localeCompare(a.ref));
  return {
    reviewer,
    projectName,
    requests: [...requests.values()].sort((a, b) => b.episodes[0]!.since.localeCompare(a.episodes[0]!.since) || a.artifact.localeCompare(b.artifact)),
    readAt: new Date().toISOString(),
  };
}

/** Access and transport failures keep the last items as stale; neither holds the source. */
export function umeReviewFailure(error: unknown): WatchFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/no stored agent token|agent_token_scope|unauthori[sz]ed|forbidden|401|403/i.test(message))
    return { kind: 'auth', message: 'ume access to this project was lost.', remedy: 'Sign this machine in to ume again with `ume login`, for this project.', retryAfterSecs: 300 };
  if (/no.such.project/i.test(message))
    return { kind: 'configuration', message: 'This ume project does not exist or is not shared with you.', remedy: 'Check [watchTypes.ume-reviews].projects.', retryAfterSecs: 900 };
  return { kind: 'ume', message: message.split('\n')[0]!.slice(0, 300), remedy: 'The source retries on its own; its last items stay listed.', retryAfterSecs: 60 };
}

const seenFile = (): string => path.join(lobstahHome(), 'ume-reviews', 'seen.json');

/** The episode the reviewer last opened, by item. */
export function umeReviewsSeen(): Record<string, string> {
  try {
    const value = JSON.parse(fs.readFileSync(seenFile(), 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Record that the reviewer opened this item's episode; a later formal request is unread again. */
export function markUmeReviewSeen(item: string, episode: string): void {
  const file = seenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seen = { ...umeReviewsSeen(), [item]: episode };
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(seen, null, 2));
  atomicRenameSync(tmp, file);
}

/** A configured project's watch, owned by the home helm; an unconfigured one is held with its items kept. */
function umeReviewRegistration(registry: () => WatchRegistry): WatchRegistrationPolicy {
  return {
    prepare(request) {
      const project = request.fields['ume.reviewProject'];
      return typeof project === 'string' && UME_PROJECT_ID.test(project) ? { input: project, options: {} } : undefined;
    },
    sync(_now, phase) {
      if (phase !== 'before-observe') return;
      const projects = new Set(configuredUmeReviewProjects());
      const journal = new WatchJournal();
      const runtime = new WatchRuntime(registry(), journal);
      for (const project of projects) {
        const stored = journal.read(`ume-reviews:${project}`);
        if (!stored || stored.status === 'retired') runtime.register('ume-reviews', project, {}, { kind: 'helm', grounds: 'home' });
        else if (stored.status === 'held' && stored.failure?.kind === 'turned-off') runtime.release(stored.key);
      }
      for (const snapshot of journal.list()) {
        if (snapshot.type.id !== 'ume-reviews' || snapshot.status !== 'watching') continue;
        if (projects.has((snapshot.reference as unknown as UmeReviewReference).project)) continue;
        // Turning a project off holds its observer and marks its items stale; ume keeps the human tasks.
        journal.update(snapshot.key, (current) => {
          if (!current || current.status !== 'watching') return { result: undefined };
          current.status = 'held';
          current.failure = {
            kind: 'turned-off',
            message: 'Incoming ume reviews are off for this project.',
            remedy: 'Add the project to [watchTypes.ume-reviews].projects to read it again.',
            hold: true,
          };
          return { snapshot: current, result: undefined };
        });
      }
    },
  };
}

export interface UmeReviewSourceOptions {
  read?: UmeRead;
}

/** The incoming ume review source; every host observes it with the same core services. */
export function createUmeReviewWatchType(registry: () => WatchRegistry, options: UmeReviewSourceOptions = {}): UmeReviewWatchType {
  return new UmeReviewWatchType({
    read: (context) => readUmeReviews(context.snapshot.reference.project, options.read),
    failure: umeReviewFailure,
    seen: umeReviewsSeen,
    effectHandler: {
      execution: 'sync',
      execute(request) {
        if (request.actionId !== UME_REVIEW_SEEN) throw new Error('Ume reviews are approved in ume.');
        const args = request.arguments as { item?: unknown; values?: { notification?: unknown } };
        if (typeof args?.item !== 'string' || typeof args.values?.notification !== 'string') throw new Error('An item and its request are required.');
        markUmeReviewSeen(args.item, args.values.notification);
        return { workIds: [] };
      },
    },
    registration: umeReviewRegistration(registry),
  });
}

export { umeReviewItemId };
