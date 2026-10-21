import type { Evidence, Verb } from '@lobstah/core';
import { loadConfig, markRepliesRule, withBriefHooks } from '@lobstah/core';
import { MARKER, lobstahWrote, marker } from '../types.js';
import type { MergeSource, PollContext, PrCandidate, PrRun, Source, TrackedItem, WorkItem } from '../types.js';
import { prEvidenceIndex, prUrlKey } from '../pr-evidence.js';

export interface GithubConfig {
  /** "owner/name" of the forge repo. */
  repo: string;
  /** Lobstah repo key dispatches and rebase chores resolve against. */
  key: string;
  /** GitHub login work is assigned to / authored by. */
  identity: string;
  token: () => string;
  startLabel: string;
  claimedLabel: string;
  /** Defaults preserve existing pickup behavior. */
  issues?: boolean;
  prFeedback?: boolean;
}

const API = 'https://api.github.com';

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

interface GhReview {
  id: number;
  user: { login: string };
  state: string;
  commit_id: string;
  submitted_at: string;
  body: string | null;
}

interface GhComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

interface GhPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base?: { ref: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  mergeable_state?: string;
  draft: boolean;
}

export class GithubSource implements Source, MergeSource {
  name: string;
  constructor(private cfg: GithubConfig) {
    this.name = `gh:${cfg.repo}`;
  }

  owns(key: string): boolean {
    if (!key.startsWith(`${this.name}#`)) return false;
    return key.startsWith(`${this.name}#pr`) ? this.cfg.prFeedback !== false : this.cfg.issues !== false;
  }

  private async api<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token()}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'lobstah-pick',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`github ${method} ${url}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  private issueKey(n: number): string {
    return `gh:${this.cfg.repo}#${n}`;
  }
  private numberOf(key: string): number {
    return Number(key.split('#').pop());
  }

  async poll(ctx?: PollContext): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    const issues = this.cfg.issues === false ? [] : await this.api<GhIssue[]>(
      'GET',
      `/repos/${this.cfg.repo}/issues?labels=${encodeURIComponent(this.cfg.startLabel)}&assignee=${this.cfg.identity}&state=open&per_page=50`,
    );
    for (const issue of issues) {
      if (issue.pull_request) continue;
      items.push({
        key: this.issueKey(issue.number),
        kind: 'issue',
        repoKey: this.cfg.key,
        title: issue.title,
        brief: `${issue.title}\n\n${issue.body ?? ''}\n\nWhen the change is complete, commit it, push the branch, and open a PR against ${this.cfg.repo} referencing #${issue.number}.`,
      });
    }
    // Post-PR feedback pickup: a dispatch is done when its PR opens, so the
    // reviewer's side of the conversation has to re-enter the queue here.
    // Any open PR that maps back to a dispatch — by its lobstah/<uuid>
    // branch, or by the PR URL its worker reported as evidence — produces a
    // review round whenever a human leaves feedback. The round's key carries
    // the newest feedback event, so every new event re-keys and the brief
    // reads the live thread rather than a snapshot; the dispatch loop
    // serializes rounds per subject.
    if (this.cfg.prFeedback === false) return items;
    const evidence = prEvidenceIndex();
    const pulls = await this.api<GhPull[]>('GET', `/repos/${this.cfg.repo}/pulls?state=open&per_page=50`);
    for (const pr of pulls) {
      const m = /^lobstah\/([0-9a-f-]{36})$/.exec(pr.head.ref);
      const uuid = m?.[1] ?? evidence.get(prUrlKey(pr.html_url));
      if (!uuid) continue;
      const subject = `gh:${this.cfg.repo}#pr${pr.number}`;
      const feedback = await this.latestFeedback(pr.number, ctx?.runs(subject, uuid) ?? []);
      if (!feedback) continue;
      items.push({
        key: `${subject}@${feedback.tag}`,
        subject,
        kind: 'review',
        repoKey: this.cfg.key,
        title: pr.title,
        followUp: uuid,
        ...(feedback.heldOnly ? { heldOnly: true } : {}),
        brief: withBriefHooks(
          `Address the review feedback on ${pr.html_url} (branch ${pr.head.ref}). Check out that branch in this worktree, read the full review discussion with \`gh pr view ${pr.number} --comments\`, implement what the feedback asks, and push. Reply to review threads where a reply is warranted. ${markRepliesRule(uuid)} When the feedback is addressed, report status done.`,
          loadConfig(),
          this.cfg.key,
          'review',
        ),
      });
    }
    return items;
  }

  /**
   * The newest human feedback event on a PR, as an opaque round tag —
   * `rv<id>` for a submitted review, `rc<id>` for an inline review-thread
   * comment, `ic<id>` for a conversation comment. Feedback means: a
   * CHANGES_REQUESTED review on any sha (a review of a slightly stale head
   * still asks for changes), a COMMENTED review with a body, or any comment
   * — always by someone other than the configured identity, and never a
   * comment or review lobstah wrote (either marker). APPROVED reviews are
   * the merge loop's signal, not feedback. Returns undefined when no one
   * has spoken.
   *
   * The configured identity's own unmarked comments count too: lobstah's
   * workers post as that account, so the owner's own "also handle X" on a trap PR
   * looks like theirs except for the marker. The active-round guard covers
   * a worker that forgets it: an identity comment made while a lobstah run
   * on the PR works is held (rounds on a subject serialize, so it waits) and
   * counts once the run ends, unless that run was itself opened only by
   * held comments, in which case it is dropped.
   */
  private async latestFeedback(n: number, runs: readonly PrRun[]): Promise<{ tag: string; heldOnly: boolean } | undefined> {
    const events: Array<{ at: string; tag: string; own: boolean }> = [];
    const own = (login: string): boolean => login === this.cfg.identity;
    const reviews = await this.paged<GhReview>(`/repos/${this.cfg.repo}/pulls/${n}/reviews`);
    for (const r of reviews) {
      if (lobstahWrote(r.body)) continue;
      const actionable = r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && (r.body ?? '').trim() !== '');
      if (actionable) events.push({ at: r.submitted_at, tag: `rv${r.id}`, own: own(r.user.login) });
    }
    for (const c of await this.paged<GhComment>(`/repos/${this.cfg.repo}/pulls/${n}/comments`)) {
      if (!lobstahWrote(c.body)) events.push({ at: c.created_at, tag: `rc${c.id}`, own: own(c.user.login) });
    }
    for (const c of await this.paged<GhComment>(`/repos/${this.cfg.repo}/issues/${n}/comments`)) {
      if (!lobstahWrote(c.body)) events.push({ at: c.created_at, tag: `ic${c.id}`, own: own(c.user.login) });
    }
    return guardFeedback(events, runs);
  }

  private async paged<T>(url: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<T[]>('GET', `${url}?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  async claim(item: WorkItem): Promise<boolean> {
    if (item.kind === 'review') return true; // the event-keyed round is the dedupe; no label dance
    const n = this.numberOf(item.key);
    const issue = await this.api<GhIssue>('GET', `/repos/${this.cfg.repo}/issues/${n}`);
    if (issue.labels.some((l) => l.name === this.cfg.claimedLabel)) return false;
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/labels`, { labels: [this.cfg.claimedLabel] });
    await this.api('DELETE', `/repos/${this.cfg.repo}/issues/${n}/labels/${encodeURIComponent(this.cfg.startLabel)}`).catch(() => {});
    return true;
  }

  async report(key: string, verb: Verb, evidence: Evidence & { uuid: string }): Promise<void> {
    const n = this.numberOf(key.replace(/@.*$/, '').replace('#pr', '#'));
    const lines = [`${marker(evidence.uuid)} **${verb}**`];
    if (evidence.prUrl) lines.push(`PR: ${evidence.prUrl}`);
    if (evidence.branch) lines.push(`branch: \`${evidence.branch}\``);
    if (evidence.note) lines.push(evidence.note);
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/comments`, { body: lines.join('\n') });
  }

  async createLiveComment(key: string, body: string): Promise<string> {
    const n = this.numberOf(key.replace(/@.*$/, '').replace('#pr', '#'));
    const result = await this.api<{ id: number }>('POST', `/repos/${this.cfg.repo}/issues/${n}/comments`, { body });
    return String(result.id);
  }

  async editLiveComment(_key: string, commentId: string, body: string): Promise<void> {
    await this.api('PATCH', `/repos/${this.cfg.repo}/issues/comments/${commentId}`, { body });
  }

  async inbound(key: string, since?: string): Promise<string[]> {
    if (key.includes('#pr')) return []; // review dispatches read the PR thread themselves
    const n = this.numberOf(key);
    const url = `/repos/${this.cfg.repo}/issues/${n}/comments${since ? `?since=${encodeURIComponent(since)}` : ''}`;
    const comments = await this.api<Array<{ body: string; user: { login: string } }>>('GET', url);
    return comments.filter((c) => c.user.login !== this.cfg.identity && !lobstahWrote(c.body)).map((c) => c.body);
  }

  async inProgress(): Promise<TrackedItem[]> {
    if (this.cfg.issues === false) return [];
    const issues = await this.api<GhIssue[]>(
      'GET',
      `/repos/${this.cfg.repo}/issues?labels=${encodeURIComponent(this.cfg.claimedLabel)}&state=all&per_page=100`,
    );
    return issues.filter((i) => !i.pull_request).map((i) => ({ key: this.issueKey(i.number), open: i.state === 'open' }));
  }

  async recoverUuid(key: string): Promise<string | undefined> {
    const n = this.numberOf(key);
    const comments = await this.api<Array<{ body: string }>>('GET', `/repos/${this.cfg.repo}/issues/${n}/comments?per_page=100`);
    for (const c of comments.reverse()) {
      const m = MARKER.exec(c.body);
      if (m) return m[1];
    }
    return undefined;
  }

  async reset(key: string, note: string): Promise<void> {
    const n = this.numberOf(key);
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/comments`, { body: note });
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/labels`, { labels: [this.cfg.startLabel] });
    await this.api('DELETE', `/repos/${this.cfg.repo}/issues/${n}/labels/${encodeURIComponent(this.cfg.claimedLabel)}`).catch(() => {});
  }

  // ── MergeSource ──────────────────────────────────────────────────────────

  private async latestReviews(n: number): Promise<GhReview[]> {
    const all = await this.api<GhReview[]>('GET', `/repos/${this.cfg.repo}/pulls/${n}/reviews?per_page=100`);
    const latest = new Map<string, GhReview>();
    for (const r of all) {
      if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
      latest.set(r.user.login, r);
    }
    return [...latest.values()];
  }

  private async toCandidate(pr: GhPull): Promise<PrCandidate> {
    const reviews = await this.latestReviews(pr.number);
    return {
      number: pr.number,
      url: pr.html_url,
      author: pr.user.login,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base?.ref,
      labels: pr.labels.map((l) => l.name),
      assignees: pr.assignees.map((a) => a.login),
      reviews: reviews.map((r) => ({ id: r.id, author: r.user.login, state: r.state, sha: r.commit_id })),
      mergeableState: pr.draft ? 'draft' : (pr.mergeable_state ?? 'unknown'),
    };
  }

  async mergeCandidates(): Promise<PrCandidate[]> {
    const pulls = await this.api<GhPull[]>('GET', `/repos/${this.cfg.repo}/pulls?state=open&per_page=50`);
    const own = pulls.filter((p) => p.user.login === this.cfg.identity || p.head.ref.startsWith('lobstah/'));
    return Promise.all(own.map((p) => this.toCandidate(p)));
  }

  async refresh(n: number): Promise<PrCandidate | undefined> {
    const pr = await this.api<GhPull>('GET', `/repos/${this.cfg.repo}/pulls/${n}`);
    return pr.state === 'open' ? this.toCandidate(pr) : undefined;
  }

  async disposition(n: number): Promise<'open' | 'merged' | 'closed'> {
    const pr = await this.api<GhPull & { merged_at?: string | null }>('GET', `/repos/${this.cfg.repo}/pulls/${n}`);
    if (pr.state === 'open') return 'open';
    return pr.merged_at ? 'merged' : 'closed';
  }

  forgeRepo(): string {
    return this.cfg.repo;
  }

  async updateBranch(n: number): Promise<void> {
    await this.api('PUT', `/repos/${this.cfg.repo}/pulls/${n}/update-branch`, {});
  }

  async requestReview(n: number, reviewers: string[]): Promise<void> {
    const pr = await this.api<GhPull>('GET', `/repos/${this.cfg.repo}/pulls/${n}`);
    const requested = [...new Set(reviewers.filter((reviewer) => reviewer.toLowerCase() !== pr.user.login.toLowerCase()))];
    if (requested.length === 0) return;
    await this.api('POST', `/repos/${this.cfg.repo}/pulls/${n}/requested_reviewers`, { reviewers: requested });
  }

  async merge(n: number, method: string): Promise<void> {
    await this.api('PUT', `/repos/${this.cfg.repo}/pulls/${n}/merge`, { merge_method: method });
  }

  async comment(n: number, text: string): Promise<void> {
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/comments`, { body: text });
  }

  async addLabel(n: number, label: string): Promise<void> {
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/labels`, { labels: [label] });
  }

  repoKey(): string {
    return this.cfg.key;
  }
}

const ms = (iso: string): number => Date.parse(iso) || 0;

/**
 * The active-round guard over a PR's feedback events (see latestFeedback):
 * the newest event that counts, and whether every event since the latest
 * run started is a held identity comment.
 */
export function guardFeedback(
  events: ReadonlyArray<{ at: string; tag: string; own: boolean }>,
  runs: readonly PrRun[],
): { tag: string; heldOnly: boolean } | undefined {
  const runAt = (at: string): PrRun | undefined =>
    runs.find((r) => ms(r.start) <= ms(at) && (r.end === undefined || ms(at) <= ms(r.end)));
  const counted: Array<{ at: string; tag: string; held: boolean }> = [];
  for (const e of events) {
    const run = e.own ? runAt(e.at) : undefined;
    if (run?.heldOnly) continue;
    counted.push({ at: e.at, tag: e.tag, held: run !== undefined });
  }
  counted.sort((a, b) => (a.at === b.at ? a.tag.localeCompare(b.tag) : ms(a.at) - ms(b.at)));
  const newest = counted.at(-1);
  if (!newest) return undefined;
  const since = Math.max(0, ...runs.map((r) => ms(r.start)));
  const opening = counted.filter((e) => ms(e.at) > since);
  return { tag: newest.tag, heldOnly: opening.length > 0 && opening.every((e) => e.held) };
}
