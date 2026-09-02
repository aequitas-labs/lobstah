import type { Evidence, Verb } from '@lobstah/core';
import { MARKER, marker } from '../types.js';
import type { Source, TrackedItem, WorkItem } from '../types.js';

export interface LinearConfig {
  token: () => string;
  /**
   * Which Linear field marks work as ours: 'assignee' (default) for a user
   * token, 'delegate' for an agent token — Linear's UI assigns work to agents
   * through the delegate field, independent of the human assignee.
   */
  assignField?: 'assignee' | 'delegate';
  /** Display name of the state issues wait in for pickup. Also the reset target. */
  startState: string;
  /**
   * Optional: poll by state *type* (e.g. ["backlog", "unstarted"]) instead of
   * the startState name — a delegated issue is meant to be done even while it
   * still sits in Backlog. startState stays the named reset target.
   */
  startStateTypes?: string[];
  /** State the item moves to on claim. */
  claimedState: string;
  /** State the item moves to when the dispatch reports done. */
  doneState: string;
  /** Team key → lobstah repo key. */
  route: Record<string, string>;
}

const API = 'https://api.linear.app/graphql';

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  team: { key: string; id: string };
}

/** Verb → Linear state-name mapping; anything unlisted keeps the claimed state. */
function stateFor(cfg: LinearConfig, verb: Verb): string | undefined {
  if (verb === 'done') return cfg.doneState;
  if (verb === 'failed') return cfg.startState;
  return undefined;
}

export class LinearSource implements Source {
  name = 'linear';
  private stateIds = new Map<string, string>();

  constructor(private cfg: LinearConfig) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: this.cfg.token(), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (!res.ok || json.errors?.length) {
      throw new Error(`linear: ${json.errors?.map((e) => e.message).join('; ') ?? res.status}`);
    }
    return json.data as T;
  }

  private async assigned(stateName: string, byTypes?: string[]): Promise<LinearIssue[]> {
    const field = this.cfg.assignField ?? 'assignee';
    const stateFilter = byTypes?.length ? { type: { in: byTypes } } : { name: { eq: stateName } };
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query($filter: IssueFilter!) {
        issues(filter: $filter, first: 50) {
          nodes { id identifier title description state { name type } team { key id } }
        }
      }`,
      { filter: { [field]: { isMe: { eq: true } }, state: stateFilter } },
    );
    return data.issues.nodes;
  }

  private async stateId(teamId: string, name: string): Promise<string> {
    const cacheKey = `${teamId}:${name}`;
    const cached = this.stateIds.get(cacheKey);
    if (cached) return cached;
    const data = await this.gql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(
      `query($team: String!) { team(id: $team) { states { nodes { id name } } } }`,
      { team: teamId },
    );
    for (const s of data.team.states.nodes) this.stateIds.set(`${teamId}:${s.name}`, s.id);
    const id = this.stateIds.get(cacheKey);
    if (!id) throw new Error(`linear: team has no state named "${name}"`);
    return id;
  }

  private async issueByKey(key: string): Promise<LinearIssue> {
    const identifier = key.replace(/^linear:/, '');
    const data = await this.gql<{ issue: LinearIssue }>(
      `query($id: String!) { issue(id: $id) { id identifier title description state { name type } team { key id } } }`,
      { id: identifier },
    );
    return data.issue;
  }

  private async moveTo(issue: LinearIssue, stateName: string): Promise<void> {
    const stateId = await this.stateId(issue.team.id, stateName);
    await this.gql(
      `mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`,
      { id: issue.id, state: stateId },
    );
  }

  private async commentOn(issue: LinearIssue, body: string): Promise<void> {
    await this.gql(
      `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
      { id: issue.id, body },
    );
  }

  async poll(): Promise<WorkItem[]> {
    const issues = await this.assigned(this.cfg.startState, this.cfg.startStateTypes);
    return issues.flatMap((issue) => {
      const repoKey = this.cfg.route[issue.team.key];
      if (!repoKey) return [];
      return [
        {
          key: `linear:${issue.identifier}`,
          kind: 'issue' as const,
          repoKey,
          title: issue.title,
          brief: `${issue.identifier}: ${issue.title}\n\n${issue.description ?? ''}\n\nWhen the change is complete, commit it, push the branch, and open a PR whose description includes "Fixes ${issue.identifier}".`,
        },
      ];
    });
  }

  async claim(item: WorkItem): Promise<boolean> {
    const issue = await this.issueByKey(item.key);
    const stillWaiting = this.cfg.startStateTypes?.length
      ? this.cfg.startStateTypes.includes(issue.state.type)
      : issue.state.name === this.cfg.startState;
    if (!stillWaiting) return false; // someone else moved it first
    await this.moveTo(issue, this.cfg.claimedState);
    return true;
  }

  async report(key: string, verb: Verb, evidence: Evidence & { uuid: string }): Promise<void> {
    const issue = await this.issueByKey(key);
    const lines = [`${marker(evidence.uuid)} **${verb}**`];
    if (evidence.prUrl) lines.push(`PR: ${evidence.prUrl}`);
    if (evidence.branch) lines.push(`branch: \`${evidence.branch}\``);
    if (evidence.note) lines.push(evidence.note);
    await this.commentOn(issue, lines.join('\n'));
    const target = stateFor(this.cfg, verb);
    if (target) await this.moveTo(issue, target);
  }

  async inbound(key: string, since?: string): Promise<string[]> {
    const identifier = key.replace(/^linear:/, '');
    const data = await this.gql<{
      issue: { comments: { nodes: Array<{ body: string; createdAt: string; user: { isMe: boolean } | null }> } };
    }>(
      `query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body createdAt user { isMe } } } } }`,
      { id: identifier },
    );
    return data.issue.comments.nodes
      .filter((c) => !c.user?.isMe && !MARKER.test(c.body))
      .filter((c) => !since || c.createdAt > since)
      .map((c) => c.body);
  }

  async inProgress(): Promise<TrackedItem[]> {
    const issues = await this.assigned(this.cfg.claimedState);
    return issues.map((i) => ({ key: `linear:${i.identifier}`, open: true }));
  }

  async recoverUuid(key: string): Promise<string | undefined> {
    const identifier = key.replace(/^linear:/, '');
    const data = await this.gql<{ issue: { comments: { nodes: Array<{ body: string }> } } }>(
      `query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { body } } } }`,
      { id: identifier },
    );
    for (const c of [...data.issue.comments.nodes].reverse()) {
      const m = MARKER.exec(c.body);
      if (m) return m[1];
    }
    return undefined;
  }

  async reset(key: string, note: string): Promise<void> {
    const issue = await this.issueByKey(key);
    await this.commentOn(issue, note);
    await this.moveTo(issue, this.cfg.startState);
  }
}
