import type { Evidence, Verb } from '@lobstah/core';
import { MARKER, marker } from '../types.js';
import type { MergeSource, PrCandidate, Source, TrackedItem, WorkItem } from '../types.js';

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
}

interface GhPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string };
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

  async poll(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    const issues = await this.api<GhIssue[]>(
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
    // Review pickup: open PRs on lobstah/<uuid> branches whose latest human
    // review is CHANGES_REQUESTED on the current head.
    const pulls = await this.api<GhPull[]>('GET', `/repos/${this.cfg.repo}/pulls?state=open&per_page=50`);
    for (const pr of pulls) {
      const m = /^lobstah\/([0-9a-f-]{36})$/.exec(pr.head.ref);
      if (!m) continue;
      const reviews = await this.latestReviews(pr.number);
      const changes = reviews.find((r) => r.state === 'CHANGES_REQUESTED' && r.commit_id === pr.head.sha);
      if (!changes) continue;
      items.push({
        key: `gh:${this.cfg.repo}#pr${pr.number}@${pr.head.sha}`,
        kind: 'review',
        repoKey: this.cfg.key,
        title: pr.title,
        followUp: m[1],
        brief: `Address the review feedback on ${pr.html_url} (branch ${pr.head.ref}). Check out that branch in this worktree, read the review comments with \`gh pr view ${pr.number} --comments\`, implement the requested changes, and push. Reply to review threads where a reply is warranted.`,
      });
    }
    return items;
  }

  async claim(item: WorkItem): Promise<boolean> {
    if (item.kind === 'review') return true; // the head-sha key is the dedupe; no label dance
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

  async inbound(key: string, since?: string): Promise<string[]> {
    if (key.includes('#pr')) return []; // review dispatches read the PR thread themselves
    const n = this.numberOf(key);
    const url = `/repos/${this.cfg.repo}/issues/${n}/comments${since ? `?since=${encodeURIComponent(since)}` : ''}`;
    const comments = await this.api<Array<{ body: string; user: { login: string } }>>('GET', url);
    return comments.filter((c) => c.user.login !== this.cfg.identity && !MARKER.test(c.body)).map((c) => c.body);
  }

  async inProgress(): Promise<TrackedItem[]> {
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
