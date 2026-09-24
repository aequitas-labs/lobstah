import type {
  GlassDispatch,
  GlassPr,
  GlassSnapshot,
  GlassTrap,
  LandedCatch,
  Notice,
  PrEvidence,
  TendAttention,
  Watch,
} from '@lobstah/core';
import { prBadge } from '@lobstah/core';

/**
 * Three /data payloads for the glass DOM tests and the fidelity diff: an
 * empty fleet, an acceptance-style fleet with a PR stack, and a fleet with
 * attention of every kind. Every time is relative to NOW.
 */
export const NOW = Date.parse('2026-09-24T12:00:00Z');
export const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const base = (): GlassSnapshot => ({
  now: ago(0),
  version: '0.5.5',
  repoUrl: 'https://github.com/aequitas-labs/lobstah',
  helms: [],
  traps: [],
  notices: [],
  watches: [],
  dispatches: [],
  prs: [],
  stacks: [],
  attention: [],
  landed: [],
  attentionKinds: ['question', 'landed', 'pr:draft', 'pr:review', 'pr:checks', 'pr:conflict', 'pr:ready'],
});

/** Nothing running: no daemon, no helm, nothing on disk. */
export function emptyFleet(): GlassSnapshot {
  return base();
}

const evidencePr = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: `https://github.com/acme/web/pull/${n}`,
  number: n,
  title: `PR ${n}`,
  state: 'OPEN',
  draft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  mergeStateStatus: 'CLEAN',
  headSha: `sha${n}`,
  baseRefName: 'main',
  headRefName: `lobstah/${n}`,
  checks: { total: 4, passed: 4, failed: 0, pending: 0 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: ago(3 * MIN),
  ...over,
});

function dispatch(id: string, over: Partial<GlassDispatch> = {}): GlassDispatch {
  const verb = over.verb ?? 'working';
  return {
    id,
    lane: 'work',
    bucket: 'active',
    repo: 'web',
    brief: `Brief for ${id.slice(0, 8)}: do the thing <carefully> & "well".`,
    attachments: [],
    messageAttachments: [],
    verb,
    note: `${verb} on ${id.slice(0, 8)}`,
    verbAt: ago(4 * MIN),
    log: [
      { at: ago(20 * MIN), verb: 'working', note: 'starting' },
      ...(verb === 'working' ? [] : [{ at: ago(4 * MIN), verb: verb as 'done', note: `${verb} on ${id.slice(0, 8)}` }]),
    ],
    inbox: [],
    sort: NOW - 4 * MIN,
    ...over,
  };
}

function glassPr(ev: PrEvidence, over: Partial<GlassPr> = {}): GlassPr {
  return {
    key: `pr:acme/web#${ev.number}`,
    url: ev.url,
    number: ev.number,
    repo: 'web',
    forgeRepo: 'acme/web',
    title: ev.title,
    state: ev.state,
    draft: ev.draft,
    checks: ev.checks,
    review: ev.review,
    reviewDecision: ev.reviewDecision,
    mergeStateStatus: ev.mergeStateStatus,
    baseRefName: ev.baseRefName,
    headRefName: ev.headRefName,
    observedAt: ev.observedAt,
    badge: prBadge(ev),
    stackId: 'pr:acme/web#41',
    floor: 'main',
    position: 0,
    nextMergeable: false,
    dispatchIds: [],
    ...over,
  };
}

const helm = () => ({
  sessionId: '7e740e13-aaaa-bbbb-cccc-000000000001',
  grounds: 'fleet',
  repos: ['web', 'api'],
  signedOnAt: ago(2 * HOUR),
  heartbeatAt: ago(30_000),
  harness: 'claude',
  cwd: '/Users/me/src/web',
  host: 'mbp',
  session: '7e740e13',
  man: 'claude @ web',
  transcript: '/Users/me/.claude/projects/-Users-me-src-web/7e740e13.jsonl',
});

const trap = (id: string, over: Partial<GlassTrap> = {}): GlassTrap => ({
  trapId: id,
  worktree: `/Users/me/.lobstah/worktrees/${id}`,
  cwd: `/Users/me/.lobstah/worktrees/${id}`,
  repo: 'web',
  harness: 'claude',
  sessionId: `${id}-session-0000`,
  signedOnAt: ago(HOUR),
  heartbeatAt: ago(MIN),
  firstParkedAt: ago(50 * MIN),
  live: true,
  messages: [],
  notices: [],
  catches: [],
  ...over,
});

/**
 * The acceptance fleet: a live daemon and helm, dispatches in every bucket
 * (one addressed to a trap, a follow-up chain), a live trap and a
 * signed-off one, and a three-PR stack (#41 → #42 → #43) with watches.
 */
export function acceptanceFleet(): GlassSnapshot {
  const d = base();
  d.daemon = { version: '0.5.5', heartbeat: ago(5_000) };
  d.helms = [helm()];
  const pr41 = evidencePr(41, { reviewDecision: 'APPROVED' });
  const pr42 = evidencePr(42, { baseRefName: 'lobstah/41', checks: { total: 4, passed: 3, failed: 0, pending: 1 } });
  const pr43 = evidencePr(43, { baseRefName: 'lobstah/42', draft: true });
  const a = dispatch('aaaaaaaa-0000-4000-8000-000000000001', {
    verb: 'done',
    bucket: 'done',
    evidence: { prUrl: pr41.url, pr: pr41, branch: 'lobstah/41' },
    prBadge: { ...prBadge(pr41), observedAt: pr41.observedAt },
    prGate: 'waiting-approval',
    sort: NOW - 30 * MIN,
  });
  const b = dispatch('bbbbbbbb-0000-4000-8000-000000000002', {
    followUp: a.id,
    evidence: { prUrl: pr42.url, pr: pr42 },
    prBadge: { ...prBadge(pr42), observedAt: pr42.observedAt },
    sort: NOW - 10 * MIN,
  });
  const c = dispatch('cccccccc-0000-4000-8000-000000000003', {
    followUp: b.id,
    verb: 'needs-decision',
    note: 'which base should #43 target?',
    claimedBy: 'wt:t1',
    evidence: { prUrl: pr43.url, pr: pr43, deliveredTo: 'wt:t1' },
    prBadge: { ...prBadge(pr43), observedAt: pr43.observedAt },
    attachments: [{ name: 'shot.png', path: '/tmp/shot.png', bytes: 2048, type: 'image/png' }],
    inbox: ['{"from":"helm","text":"target main"}'],
    transcript: '/Users/me/.claude/projects/x/c.jsonl',
    sort: NOW - 2 * MIN,
  });
  const q = dispatch('dddddddd-0000-4000-8000-000000000004', {
    bucket: 'queued',
    verb: 'unknown',
    note: undefined,
    verbAt: undefined,
    log: [],
    repo: 'api',
    lane: 'chore',
    for: 'wt:t2',
    sort: NOW - MIN,
  });
  d.dispatches = [q, c, b, a];
  d.prs = [
    glassPr(pr41, { position: 0, nextMergeable: true, dispatchIds: [a.id, b.id, c.id], gate: 'waiting-approval' }),
    glassPr(pr42, {
      position: 1,
      blockedBy: 41,
      dispatchIds: [a.id, b.id, c.id],
      watch: { key: 'pr:acme/web#42', owner: `dispatch:${b.id}`, cursor: 'eyJoIjoiYWJjIn0-a-long-opaque-cursor', lastCheckedAt: ago(MIN) },
    }),
    glassPr(pr43, { position: 2, blockedBy: 42, dispatchIds: [a.id, b.id, c.id, 'eeeeeeee-culled'] }),
  ];
  d.stacks = [{ id: 'pr:acme/web#41', floor: 'main', repo: 'web', numbers: [41, 42, 43], open: true, nextNumber: 41, behind: 2 }];
  const watches: Watch[] = [
    { key: 'pr:acme/web#42', owner: `dispatch:${b.id}`, check: 'gh', cursor: 'eyJoIjoiYWJjIn0-a-long-opaque-cursor', createdAt: ago(HOUR), lastCheckedAt: ago(MIN), seen: 0, seenAt: 0 },
    { key: 'ci-nightly', owner: 'man', check: 'ci', cursor: '17', createdAt: ago(HOUR), lastCheckedAt: ago(2 * MIN), lastError: 'exit 1', seen: 0, seenAt: 0 },
  ];
  d.watches = watches;
  const notices: Notice[] = [
    { seq: '0003', kind: 'trap-listening', at: ago(50 * MIN), text: 'wt:t1 listening', refId: 't1', repo: 'web' },
    { seq: '0002', kind: 'trap-stowed', at: ago(30 * MIN), text: 'wt:t2 stowed', refId: 't2', repo: 'api' },
    { seq: '0001', kind: 'pr-merged', at: ago(3 * HOUR), text: '#40 merged', repo: 'web' },
  ];
  d.notices = notices;
  d.traps = [
    trap('t1', {
      claimed: c.id,
      messages: [
        { file: '0001.msg', state: 'delivered', from: 'helm', at: ago(40 * MIN), text: 'pick up #43' },
        {
          file: '0002.msg',
          state: 'pending',
          from: 'tender',
          at: ago(MIN),
          text: 'screenshot attached',
          attachments: [{ name: 'a.png', path: '/tmp/a.png', bytes: 10, type: 'image/png' }],
        },
      ],
      notices: [notices[0]!],
      catches: [c],
    }),
    {
      trapId: 't2',
      live: false,
      messages: [],
      notices: [notices[1]!],
      catches: [q],
    },
  ];
  d.landed = [{ key: `work:${a.id}`, id: a.id, lane: 'work', verb: 'done', at: ago(30 * MIN), note: 'opened #41', repo: 'web', prUrl: pr41.url, unreported: true }];
  d.attention = [
    {
      kind: 'question',
      key: `work:${c.id}`,
      stateHash: 'q1',
      id: c.id,
      lane: 'work',
      verb: 'needs-decision',
      ageSecs: 120,
      at: ago(2 * MIN),
      note: 'which base should #43 target?',
      repo: 'web',
    },
    { kind: 'pr:draft', key: 'pr:acme/web#43', stateHash: 'd1', id: c.id, lane: 'work', verb: 'pr:draft', ageSecs: 180, at: ago(3 * MIN), note: '#43 draft', repo: 'web', prUrl: pr43.url },
  ];
  return d;
}

/** Every attention kind at once, some acked, plus a stale daemon and helm and more than a deck's worth of each list. */
export function everyAttentionFleet(): GlassSnapshot {
  const d = acceptanceFleet();
  d.daemon = { version: '0.5.4', heartbeat: ago(10 * MIN) };
  d.helms = [{ ...helm(), heartbeatAt: ago(45 * MIN), harness: 'codex' }];
  const kinds: Array<TendAttention['kind']> = ['question', 'landed', 'pr:draft', 'pr:review', 'pr:checks', 'pr:conflict', 'pr:ready', 'watch'];
  const [c] = d.dispatches.filter((x) => x.verb === 'needs-decision');
  d.attention = kinds.map((kind, i): TendAttention => ({
    kind,
    key: kind.startsWith('pr:') ? `pr:acme/web#${41 + (i % 3)}` : kind === 'watch' ? 'watch:ci-nightly' : `work:${c!.id}`,
    stateHash: `h${i}`,
    id: c!.id,
    lane: 'work',
    verb: kind === 'question' ? 'blocked' : kind === 'landed' ? 'failed' : kind === 'watch' ? 'watch' : kind,
    ageSecs: 60 * (i + 1),
    at: ago((i + 1) * MIN),
    note: `${kind} item ${i}`,
    repo: 'web',
    ...(kind.startsWith('pr:') ? { prUrl: `https://github.com/acme/web/pull/${41 + (i % 3)}` } : {}),
    ...(i % 3 === 1 ? { acked: { at: ago(MIN), by: 'pet' } } : {}),
  }));
  // More questions than the deck shows, so the "+N more" links render.
  for (let i = 0; i < 4; i++) {
    d.attention.push({
      kind: 'question',
      key: `work:extra${i}`,
      stateHash: `x${i}`,
      id: `ffffffff-0000-4000-8000-00000000000${i}`,
      lane: 'work',
      verb: 'needs-decision',
      ageSecs: 30,
      at: ago(30_000),
      note: `extra question ${i}`,
      repo: 'api',
    });
  }
  const landed: LandedCatch[] = Array.from({ length: 10 }, (_, i) => ({
    key: `work:l${i}`,
    id: `1${i}aaaaaa-0000-4000-8000-000000000000`,
    lane: 'work',
    verb: i === 2 ? 'failed' : 'done',
    at: ago((i + 1) * HOUR),
    note: `catch ${i}`,
    repo: 'web',
    unreported: i < 4,
  }));
  landed.push({ key: 'work:old', id: 'old00000-0000', lane: 'work', verb: 'done', at: ago(30 * HOUR), note: 'yesterday', repo: 'web', unreported: false });
  d.landed = landed;
  for (let i = 0; i < 5; i++) d.dispatches.push(dispatch(`9${i}999999-0000-4000-8000-000000000000`, { verb: i % 2 ? 'blocked' : 'working', sort: NOW - (40 + i) * MIN }));
  d.traps.push(trap('t3', { heartbeatAt: ago(2 * HOUR), firstParkedAt: undefined, harness: 'codex' }), trap('t4'));
  d.stacks.push(
    { id: 'pr:acme/web#50', floor: 'main', repo: 'web', numbers: [50], open: true, nextNumber: 50, behind: 0 },
    { id: 'pr:acme/web#60', floor: 'main', repo: 'web', numbers: [60], open: true, behind: 0 },
    { id: 'pr:acme/web#61', floor: 'main', repo: 'web', numbers: [61], open: true, behind: 0 },
    { id: 'pr:acme/web#30', floor: 'main', repo: 'web', numbers: [30], open: false, behind: 0 },
  );
  const conflict = evidencePr(50, { mergeStateStatus: 'DIRTY' });
  const merged = evidencePr(30, { state: 'MERGED', mergedAt: ago(5 * HOUR) });
  const failing = evidencePr(60, { checks: { total: 3, passed: 1, failed: 2, pending: 0 }, review: { unresolvedThreads: 2, changesRequested: true }, reviewDecision: 'CHANGES_REQUESTED' });
  const behind = evidencePr(61, { mergeStateStatus: 'BEHIND' });
  d.prs.push(
    glassPr(conflict, { stackId: 'pr:acme/web#50', position: 0, nextMergeable: true }),
    glassPr(failing, { stackId: 'pr:acme/web#60', position: 0 }),
    glassPr(behind, { stackId: 'pr:acme/web#61', position: 0 }),
    glassPr(merged, { stackId: 'pr:acme/web#30', position: 0 }),
  );
  d.attentionError = undefined;
  return d;
}

export const FIXTURES: Record<string, () => GlassSnapshot> = {
  empty: emptyFleet,
  acceptance: acceptanceFleet,
  'every-attention': everyAttentionFleet,
};
