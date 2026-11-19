import { dispatchPrLines, parsePrRef, routePrQuestionReply, syncDispatchPrQuestions, laneOf } from '@lobstah/core';
import type { PrQuestionReply, PrQuestionTransport, PrRef } from '@lobstah/core';
import type { Evidence, Verb } from '@lobstah/core';
import { loadConfig, markRepliesRule, withBriefHooks } from '@lobstah/core';
import { MARKER, lobstahWrote, marker } from '../types.js';
import type { AsyncMergeResult, MergeSource, PollContext, PrCandidate, PrRun, Source, TrackedItem, WorkItem } from '../types.js';
import { prEvidenceIndex, prUrlKey } from '../pr-evidence.js';
import { reviewDiffId } from '../reviews-diff.js';

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
  user: { login: string; type?: string };
  created_at: string;
  html_url?: string;
  in_reply_to_id?: number;
}

/** REST keeps every reply; GraphQL supplies the thread's resolution state. */
interface GhReviewComment extends GhComment {
  node_id: string;
  pull_request_review_id: number | null;
  in_reply_to_id?: number;
}

interface GhReviewThread {
  path: string;
  line: number | null;
  originalLine: number | null;
  isResolved: boolean;
  comments: { nodes: Array<{ id: string; url: string }> };
}

interface GhThreadPage {
  nodes: GhReviewThread[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** A submitted review and its initial inline comments share one event. */
interface FeedbackEvent {
  at: string;
  tag: string;
  own: boolean;
  review?: GhReview;
}

interface PrFeedback {
  tag: string;
  heldOnly: boolean;
  context: string;
  /** Root inline thread that opened the selected feedback event, when unambiguous. */
  reviewThreadId?: number;
}

/** Wait for a quiet interval before claiming a burst of review feedback. */
const REVIEW_FEEDBACK_SETTLE_MS = 30_000;

interface GhPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string; repo?: { full_name?: string } };
  base?: { ref: string; sha?: string; repo?: { default_branch?: string; full_name?: string } };
  stack?: { number: number; position: number; size: number; base: { ref: string } } | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  mergeable_state?: string;
  draft: boolean;
}

export class GithubSource implements Source, MergeSource {
  name: string;
  /** Share a missing-default lookup within a tick, and refresh it next tick. */
  private defaultBranchRead?: Promise<string>;
  /** Immutable SHA pairs share comparisons across polls; failures remain retryable. */
  private reviewDiffs = new Map<string, string>();
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
        'X-GitHub-Api-Version': '2026-03-10',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 409 && url.endsWith('/merge-async')) {
      const existing = await res.json() as AsyncMergeResult;
      if (existing.status === 'pending' && existing.details?.uuid &&
          existing.details.expected_head_sha === (body as { sha?: string })?.sha &&
          existing.details.merge_method === (body as { merge_method?: string })?.merge_method) return existing as T;
      throw new Error('github merge-async: 409 A different merge request is already pending.');
    }
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
      const feedback = await this.latestFeedback(pr.number, pr.user.login, ctx?.runs(subject, uuid) ?? []);
      if (!feedback) continue;
      items.push({
        key: `${subject}@${feedback.tag}`,
        subject,
        kind: 'review',
        repoKey: this.cfg.key,
        title: pr.title,
        followUp: uuid,
        pr: { url: pr.html_url, headRefName: pr.head.ref, headSha: pr.head.sha, ...(feedback.reviewThreadId ? { reviewThreadId: feedback.reviewThreadId } : {}) },
        ...(feedback.heldOnly ? { heldOnly: true } : {}),
        brief: withBriefHooks(
          `Address the review feedback on ${pr.html_url} (branch ${pr.head.ref}). Check out that branch in this worktree, read the full review discussion with \`gh pr view ${pr.number} --comments\`, implement what the feedback asks, and push. Reply to review threads where a reply is warranted. ${markRepliesRule(uuid)} When the feedback is addressed, report status done.${feedback.context}`,
          loadConfig(),
          this.cfg.key,
          'review',
        ),
      });
    }
    return items;
  }

  /**
   * The newest actionable feedback event on a PR, as an opaque round tag —
   * `rv<id>` for a submitted review, `rc<id>` for an inline review-thread
   * comment, `ic<id>` for a conversation comment. Feedback means: a
   * CHANGES_REQUESTED review on any sha (a review of a slightly stale head
   * still asks for changes), a COMMENTED review with a body or inline
   * comments, or a standalone inline comment. Reviews and inline comments
   * from the PR author or configured identity never count. Initial comments
   * on APPROVED, DISMISSED, pending or marked reviews never count either.
   *
   * The configured identity's own unmarked conversation comments count too:
   * workers post as that account, so the owner's own "also handle X" on a
   * trap PR looks like theirs except for the marker. The active-round guard covers
   * a worker that forgets it: an identity comment made while a lobstah run
   * on the PR works is held (rounds on a subject serialize, so it waits) and
   * counts once the run ends, unless that run was itself opened only by
   * held comments, in which case it is dropped.
   */
  private async latestFeedback(pullNumber: number, workerLogin: string, runs: readonly PrRun[]): Promise<PrFeedback | undefined> {
    const pr = parsePrRef(`https://github.com/${this.cfg.repo}/pull/${pullNumber}`)!;
    const events: FeedbackEvent[] = [];
    const isOwnIdentity = (login: string): boolean => login.toLowerCase() === this.cfg.identity.toLowerCase();
    const isWorker = (login: string): boolean => isOwnIdentity(login) || login.toLowerCase() === workerLogin.toLowerCase();
    const reviews = await this.paged<GhReview>(`/repos/${this.cfg.repo}/pulls/${pullNumber}/reviews`);
    const discussion = await this.paged<GhReviewComment>(`/repos/${this.cfg.repo}/pulls/${pullNumber}/comments`);
    const conversation = await this.paged<GhComment>(`/repos/${this.cfg.repo}/issues/${pullNumber}/comments`);
    const replies = [...discussion.map((reply) => ({ reply, kind: 'review' as const })), ...conversation.map((reply) => ({ reply, kind: 'conversation' as const }))]
      .sort((left, right) => ms(left.reply.created_at) - ms(right.reply.created_at) || left.reply.id - right.reply.id);
    const answers = new Set<string>();
    for (const { reply, kind } of replies) {
      if (routePrQuestionReply(pr, reply, this.cfg.identity, kind)) answers.add(`${kind}:${reply.id}`);
    }
    // Answers must leave the candidate set before an inline-only review can wake a round.
    const comments = discussion.filter((comment) => !answers.has(`review:${comment.id}`));
    const byReview = new Map(reviews.map((review) => [review.id, review]));
    const isExternalComment = (comment: GhReviewComment): boolean => !isWorker(comment.user.login) && !lobstahWrote(comment.body);
    for (const review of reviews) {
      if (!review.submitted_at || isWorker(review.user.login) || lobstahWrote(review.body)) continue;
      const inline = comments.some((comment) => comment.pull_request_review_id === review.id &&
        ms(comment.created_at) <= ms(review.submitted_at) && isExternalComment(comment));
      const actionable = review.state === 'CHANGES_REQUESTED' || (review.state === 'COMMENTED' && ((review.body ?? '').trim() !== '' || inline));
      if (actionable) events.push({ at: review.submitted_at, tag: `rv${review.id}`, own: false, review });
    }
    for (const c of comments) {
      if (!isExternalComment(c)) continue;
      const review = c.pull_request_review_id == null ? undefined : byReview.get(c.pull_request_review_id);
      // A submitted review owns its initial comments, including non-actionable
      // reviews. A later reply is new feedback even when GitHub reuses its id.
      if (review && (!review.submitted_at || ms(c.created_at) <= ms(review.submitted_at))) continue;
      events.push({ at: c.created_at, tag: `rc${c.id}`, own: false,
        ...(review && !isWorker(review.user.login) && !lobstahWrote(review.body) &&
          ['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state) ? { review } : {}),
      });
    }
    for (const c of conversation) {
      if (answers.has(`conversation:${c.id}`)) continue;
      if (!lobstahWrote(c.body)) events.push({ at: c.created_at, tag: `ic${c.id}`, own: isOwnIdentity(c.user.login) });
    }
    const feedback = guardFeedback(events, runs);
    if (!feedback) return undefined;
    const trigger = events.find((event) => event.tag === feedback.tag)!;
    // Conversation comments retain their existing immediate pickup behavior.
    if (trigger.tag.startsWith('ic')) return { ...feedback, context: '' };
    if (Date.now() - ms(trigger.at) < REVIEW_FEEDBACK_SETTLE_MS) return undefined;
    const threads = await this.unresolvedFeedbackThreads(pullNumber, discussion);
    const review = trigger.review;
    const origin = comments.find((comment) => trigger.tag === `rc${comment.id}`);
    const initialThreads = review ? [...new Set(comments.filter((comment) => comment.pull_request_review_id === review.id &&
      ms(comment.created_at) <= ms(review.submitted_at) && isExternalComment(comment)).map((comment) => comment.in_reply_to_id ?? comment.id))] : [];
    const reviewThreadId = origin ? origin.in_reply_to_id ?? origin.id : initialThreads.length === 1 ? initialThreads[0] : undefined;
    const body = review ? `\n\nReview by ${review.user.login} (${review.state}):\n${review.body?.trim() || '(No review body.)'}` : '';
    return { ...feedback, context: `${body}${threads}`, ...(reviewThreadId !== undefined ? { reviewThreadId } : {}) };
  }

  /** Read all thread pages; never dispatch a brief that silently lost a page. */
  private async unresolvedFeedbackThreads(pullNumber: number, comments: readonly GhReviewComment[]): Promise<string> {
    const [owner, repo] = this.cfg.repo.split('/');
    const threads: string[] = [];
    const visited = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: { data?: { repository?: { pullRequest?: { reviewThreads: GhThreadPage } } }; errors?: Array<{ message: string }> } =
        await this.api('POST', '/graphql', {
          query: `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { path line originalLine isResolved comments(first: 1) { nodes { id url } } }
              }
            } }
          }`,
          variables: { owner, repo, number: pullNumber, cursor },
        });
      const page = result.data?.repository?.pullRequest?.reviewThreads;
      if (result.errors?.length || !page?.pageInfo || !Array.isArray(page.nodes)) throw new Error('github review feedback: could not read complete review threads');
      for (const thread of page.nodes) {
        if (thread.isResolved) continue;
        const root = thread.comments.nodes[0];
        if (!root) throw new Error('github review feedback: missing thread comment');
        const rootComment = comments.find((comment) => comment.node_id === root.id);
        if (!rootComment) throw new Error('github review feedback: missing thread discussion');
        const discussion = comments.filter((comment) => comment.id === rootComment.id || comment.in_reply_to_id === rootComment.id);
        const line = thread.line ?? thread.originalLine;
        threads.push(`${thread.path}${line == null ? '' : `:${line}`} — ${root.url}\n${discussion.map((comment) => `${comment.user.login}: ${comment.body}`).join('\n\n')}`);
      }
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (!cursor || visited.has(cursor)) throw new Error('github review feedback: repeated or missing thread cursor');
      visited.add(cursor);
    } while (cursor);
    return threads.length ? `\n\nUnresolved review threads:\n\n${threads.join('\n\n')}` : '';
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
    if (key.includes('#pr') && verb === 'needs-decision') {
      await syncDispatchPrQuestions(evidence.uuid, laneOf(evidence.uuid) ?? 'work', this.questionTransport(), parsePrRef(`https://github.com/${this.cfg.repo}/pull/${n}`)!);
      return;
    }
    const lines = [`${marker(evidence.uuid)} **${verb}**`];
    lines.push(...dispatchPrLines(evidence));
    if (evidence.branch) lines.push(`branch: \`${evidence.branch}\``);
    if (evidence.note) lines.push(evidence.note);
    await this.api('POST', `/repos/${this.cfg.repo}/issues/${n}/comments`, { body: lines.join('\n') });
  }

  /** Reuse pickup's authenticated API while keeping question writes separate from tracker comments. */
  private questionTransport(): PrQuestionTransport {
    const repo = (pr: PrRef) => `/repos/${pr.owner}/${pr.repo}`;
    return {
      identity: this.cfg.identity,
      comments: (pr) => this.paged<PrQuestionReply>(`${repo(pr)}/issues/${pr.number}/comments`),
      reviewComments: (pr) => this.paged<PrQuestionReply>(`${repo(pr)}/pulls/${pr.number}/comments`),
      post: (pr, body) => this.api('POST', `${repo(pr)}/issues/${pr.number}/comments`, { body }),
      edit: (pr, id, body) => this.api('PATCH', `${repo(pr)}/issues/comments/${id}`, { body }),
    };
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

  /** Reuse successful comparisons only; a changed base gets a fresh comparison. */
  private async reviewedChanges(base: string, head: string): Promise<string | undefined> {
    const key = `${base}...${head}`;
    const cached = this.reviewDiffs.get(key);
    if (cached) return cached;
    const fingerprint = await reviewDiffId(this.cfg.repo, base, head,
      { token: this.cfg.token, now: Date.now(), log: (_message: string): void => {} });
    if (fingerprint) {
      if (this.reviewDiffs.size >= 200) this.reviewDiffs.clear();
      this.reviewDiffs.set(key, fingerprint);
    }
    return fingerprint;
  }

  private async toCandidate(pr: GhPull): Promise<PrCandidate> {
    const eligible = (pr.user.login === this.cfg.identity || pr.head.ref.startsWith('lobstah/')) && (!pr.head.repo?.full_name || pr.head.repo.full_name.toLowerCase() === this.cfg.repo.toLowerCase());
    const reviews = eligible ? await this.latestReviews(pr.number) : [];
    const defaultBranch = pr.base?.repo?.default_branch ?? await (this.defaultBranchRead ??=
      this.api<{ default_branch: string }>('GET', `/repos/${this.cfg.repo}`).then((repository) => repository.default_branch));
    if (!defaultBranch) throw new Error('GitHub did not return the default branch.');
    const unchangedHeads = new Set<string>();
    const previousApprovals = reviews.filter(review => review.state === 'APPROVED' && review.commit_id !== pr.head.sha);
    if (pr.base?.sha && previousApprovals.length) {
      const currentDiff = await this.reviewedChanges(pr.base.sha, pr.head.sha);
      if (currentDiff) for (const head of new Set(previousApprovals.map(review => review.commit_id))) {
        const reviewedDiff = await this.reviewedChanges(pr.base.sha, head);
        if (reviewedDiff === currentDiff) unchangedHeads.add(head);
      }
    }
    return {
      number: pr.number,
      url: pr.html_url,
      author: pr.user.login,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base?.ref,
      defaultBranch,
      ...(pr.stack ? { linkedStack: { ...pr.stack, base: pr.stack.base.ref } } : {}),
      eligible,
      labels: pr.labels.map((l) => l.name),
      assignees: pr.assignees.map((a) => a.login),
      reviews: reviews.map((r) => ({ id: r.id, author: r.user.login, state: r.state, sha: r.commit_id,
        ...(unchangedHeads.has(r.commit_id) ? { unchanged: true } : {}) })),
      mergeableState: pr.draft ? 'draft' : (pr.mergeable_state ?? 'unknown'),
    };
  }

  async mergeCandidates(): Promise<PrCandidate[]> {
    this.defaultBranchRead = undefined;
    const pulls: GhPull[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<GhPull[]>('GET', `/repos/${this.cfg.repo}/pulls?state=open&per_page=100&page=${page}`);
      pulls.push(...batch);
      if (batch.length < 100) break;
    }
    return Promise.all(pulls.map((p) => this.toCandidate(p)));
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
    const pr = await this.api<GhPull>('GET', `/repos/${this.cfg.repo}/pulls/${n}`);
    await this.api('PUT', `/repos/${this.cfg.repo}/pulls/${n}/update-branch`, { expected_head_sha: pr.head.sha });
  }

  async requestReview(n: number, reviewers: string[]): Promise<void> {
    const pr = await this.api<GhPull>('GET', `/repos/${this.cfg.repo}/pulls/${n}`);
    const requested = [...new Set(reviewers.filter((reviewer) => reviewer.toLowerCase() !== pr.user.login.toLowerCase()))];
    if (requested.length === 0) return;
    await this.api('POST', `/repos/${this.cfg.repo}/pulls/${n}/requested_reviewers`, { reviewers: requested });
  }

  async merge(n: number, method: string, expectedHead?: string): Promise<void> {
    const result = await this.api<{ merged?: boolean; message?: string }>('PUT', `/repos/${this.cfg.repo}/pulls/${n}/merge`, { merge_method: method, ...(expectedHead ? { sha: expectedHead } : {}) });
    if (result.merged !== true) throw new Error(result.message ?? 'GitHub did not merge the PR.');
  }

  /** Retarget before update-branch so GitHub merges the default branch into the head. */
  async retarget(number: number, branch: string): Promise<void> {
    await this.api('PATCH', `/repos/${this.cfg.repo}/pulls/${number}`, { base: branch });
  }

  /** Compare branch ancestry instead of assuming a clean rollup means up to date. */
  async includesBase(number: number): Promise<boolean> {
    const pr = await this.api<GhPull>('GET', `/repos/${this.cfg.repo}/pulls/${number}`);
    if (!pr.base?.sha) throw new Error('GitHub did not return the base commit.');
    const comparison = await this.api<{ behind_by: number }>('GET', `/repos/${this.cfg.repo}/compare/${pr.base.sha}...${pr.head.sha}`);
    return comparison.behind_by === 0;
  }

  /** Check the same head the gate approved, including optional failing checks. */
  async checks(number: number, head: string): Promise<'green' | 'pending' | 'red'> {
    const [owner, repo] = this.cfg.repo.split('/');
    const result = await this.api<{ data?: { repository?: { pullRequest?: { headRefOid: string; commits: { nodes: Array<{ commit: { statusCheckRollup?: { state: string } | null } }> } } } }; errors?: unknown[] }>('POST', '/graphql', {
      query: 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}',
      variables: { owner, repo, number },
    });
    const pr = result.data?.repository?.pullRequest;
    if (result.errors?.length || !pr || pr.headRefOid !== head) return 'pending';
    const status = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
    return status === 'SUCCESS' ? 'green' : status === 'FAILURE' || status === 'ERROR' ? 'red' : 'pending';
  }

  /** GitHub's actual linked membership, not a branch-name inference. */
  async linkedMembers(stack: number): Promise<number[]> {
    const result = await this.api<{ pull_requests: Array<{ number: number; state: string }> }>('GET', `/repos/${this.cfg.repo}/stacks/${stack}`);
    return result.pull_requests.filter((pr) => pr.state === 'open').map((pr) => pr.number);
  }

  /** Native stacks must use the asynchronous endpoint; it includes open downstack members. */
  async mergeLinked(number: number, method: string, head: string): Promise<AsyncMergeResult> {
    return this.api('PUT', `/repos/${this.cfg.repo}/pulls/${number}/merge-async`, { merge_method: method, sha: head, merge_action: 'default' });
  }

  /** Poll at the existing pickup cadence, without a second watcher. */
  async linkedResult(number: number, uuid: string): Promise<AsyncMergeResult> {
    return this.api('GET', `/repos/${this.cfg.repo}/pulls/${number}/merge-async/${encodeURIComponent(uuid)}`);
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
