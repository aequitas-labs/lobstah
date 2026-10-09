import type { GlassDispatch, GlassDispatchSummary, GlassHelm, GlassReport, GlassSnapshot } from '@lobstah/core';
import type { GlassTrapView as GlassTrap } from '../../../src/glass-diff.js';
import {
  desktopSession,
  dispatchReport,
  modalItem,
  prBadgeClass,
  prModalView,
  reportPageUrl,
  trapFileUrl,
} from '../../../src/glass-diff.js';
import type { DispatchDetail, GlassPrefs, ModalRef, PrModalView, SettingsItem } from '../../../src/glass-diff.js';
import { closeModal, setLobs, setView, showModal } from '../actions.js';
import { html } from '../html.js';
import { reportByline } from './report.js';
import {
  Age,
  WorkerDetails,
  addrCell,
  attachmentRows,
  cmdRow,
  resumeRow,
  startCommands,
  detailBody,
  NamedText,
  opener,
  TrapName,
  namedText,
  prCell,
  prChecks,
  prLink,
  prMerge,
  prReview,
  stackNumbers,
  trapRow,
  windowAction,
} from './common.js';

/** The overlay's one modal: dispatch, trap, helm, PR, report, or ⚙ settings. */

const close = html`<span class="x" onClick=${closeModal}>×</span>`;

// Per-browser preferences (localStorage); the kinds line is read-only config.
const seg = (set: (v: string) => void, opts: Array<[string, string]>, cur: string) =>
  html`<span class="seg">${opts.map(([v, l]) => html`<button class=${v === cur ? 'on' : ''} onClick=${() => set(v)}>${l}</button>`)}</span>`;

function settingsModal(item: SettingsItem, prefs: GlassPrefs) {
  const view = seg(
    setView,
    [
      ['table', 'table'],
      ['cards', 'cards'],
    ],
    prefs.view,
  );
  const lobs = seg(
    setLobs,
    [
      ['on', 'on'],
      ['off', 'off'],
    ],
    prefs.lobs ? 'on' : 'off',
  );
  const kinds = item.attentionError ? item.attentionError : (item.attentionKinds || []).join(' · ');
  return [
    close,
    html`<h3>⚙ settings <span class="dim" style="font-weight:normal">· this browser only</span></h3>`,
    html`<div class="settings"><div class="row"><span class="lbl">view<span class="hint">cards or table (notices stay a table)</span></span>${view}</div><div class="row"><span class="lbl">lobs<span class="hint">crawling lobsters in this page</span></span>${lobs}</div><div class="row"><span class="lbl">attention<span class="hint">kinds shown — attentionKinds in config.toml (read-only here)</span></span><span class="dim" style="font-size:11px;text-align:right;max-width:260px">${kinds}</span></div></div>`,
  ];
}

function stackLine(p: PrModalView['pr'], s: NonNullable<PrModalView['stack']>) {
  const numbers = stackNumbers(s.numbers, new Map(s.numbers.map((n, i) => [n, s.titles[i]])), p.number);
  const next = s.nextMergeable
    ? [' · ', html`<span class="ok">next mergeable</span>`]
    : s.blockedBy
      ? ' · blocked by #' + s.blockedBy
      : s.nextNumber
        ? ' · next is #' + s.nextNumber
        : '';
  return [numbers, ' · ', s.position, ' of ', s.size, ' · floor ', s.floor, next];
}

/** A dispatch-chain link: opens that dispatch's modal instead of following the #. */
const follow = (key: string) => (e: Event) => {
  e.preventDefault();
  showModal('dispatch', key);
};

function prModal(d: GlassSnapshot, key: string) {
  const v = prModalView(d, key)!,
    p = v.pr,
    s = v.stack,
    w = v.watch;
  const review = prReview(p);
  const chain = v.chain.length
    ? v.chain.flatMap((c, i) => [
        i ? ' → ' : '',
        c.culled
          ? html`<span class="dim">${c.id.slice(0, 8)} (culled)</span>`
          : [html`<a href="#" onClick=${follow(c.modalKey!)}>${c.id.slice(0, 8)}</a>`, ' ', html`<span class="dim">${c.verb}</span>`],
      ])
    : html`<span class="dim">none</span>`;
  const watch = w
    ? [
        html`<div>${w.key} · owner ${w.owner || '?'} · ${w.lastCheckedAt ? ['checked ', Age(w.lastCheckedAt), ' ago'] : 'never checked'}</div>`,
        w.lastError && html`<div class="bad">${w.lastError}</div>`,
        html`<div class="dim" style="font-size:11px;margin-top:4px">cursor</div>`,
        cmdRow(w.cursor),
      ]
    : html`<div class="dim">no watch — <code>lobstah watch add ${p.url}</code> registers one</div>`;
  return [
    close,
    html`<h3>${prLink(p)} ${p.title || ''} <span class=${'badge ' + prBadgeClass(p.badge)}>${p.badge.text}</span>${p.draft && p.badge.text !== 'draft' && [' ', html`<span class="badge pr-draft">draft</span>`]}</h3>`,
    html`<div class="sub">${p.repo} · ${p.state} · observed ${Age(p.observedAt)} ago${p.gate && ' · gate ' + p.gate}</div>`,
    html`<div class="sec">checks</div><div>${prChecks(p)}</div><div class="sec">review</div><div>${review || html`<span class="dim">no review yet</span>`}</div><div class="sec">merge</div><div>${prMerge(p)}</div>${p.repairWait && html`<div class="sec">repair waits</div><div>${p.repairWait.heldBy}: ${p.repairWait.reason}${p.repairWait.until ? ' · until ' + p.repairWait.until : ''}</div>`}<div class="sec">refs</div><div>${p.headRefName || '?'} → ${p.baseRefName || '?'}</div><div class="sec">stack</div><div>${s ? stackLine(p, s) : html`<span class="dim">not stacked</span>`}</div><div class="sec">dispatch chain</div><div>${chain}</div><div class="sec">watch</div>`,
    watch,
  ];
}

function helmModal(h: GlassHelm) {
  const stale = Date.now() - Date.parse(h.heartbeatAt) > 1800000;
  return [
    close,
    html`<h3>⛵ ${h.man}</h3><div class="sub">helm of <b>${h.grounds}</b> (${(h.repos || []).join(', ')})</div><div class="sub">${h.cwd ?? '?'}${h.host && ' · ' + h.host}</div><div class="sub">session ${h.sessionId ?? ''} · signed on ${Age(h.signedOnAt)} ago · heartbeat <span class=${stale ? 'warn' : 'ok'}>${Age(h.heartbeatAt)} ago</span></div>`,
    html`<${WorkerDetails} worker=${h} />`,
    h.sessionId && [html`<div class="sec">open this session</div>`, resumeRow(h)],
    h.transcript && [html`<div class="sec">transcript</div>`, cmdRow(h.transcript)],
  ];
}

/** A dispatch's report, in its modal: the title and byline, and a link to the report's own page. */
function reportLink(r: GlassReport) {
  return [
    html`<div class="sec">report · ${r.title}</div>`,
    html`<div class="sub">${reportByline(r)} · <a href=${reportPageUrl(r.key)} target="_blank" rel="noopener">open the report ↗</a></div>`,
  ];
}

function dispatchModal(x: GlassDispatchSummary | GlassDispatch, report: GlassReport | undefined, detail: DispatchDetail | null) {
  const session =
    x.claimedBy && x.claimedBy.startsWith('wt:')
      ? [
          html`<div class="sec">worked by trap</div>`,
          html`<div class="claimedby">claimed by ${TrapName(x.claimedBy.slice('wt:'.length))}</div>`,
          cmdRow(namedText(x.claimedBy)),
          html`<div class="dim" style="font-size:11px">an opted-in interactive session mans this seat — attach would resume someone's live thread. Message it instead: lobstah send ${namedText(x.claimedBy)} "…"</div>`,
        ]
      : [html`<div class="sec">open this session</div>`, cmdRow('lobstah attach ' + x.id)];
  return [
    close,
    html`<h3>${x.id.slice(0, 8)} <span class=${'badge v-' + x.verb}>${x.verb}</span></h3>`,
    html`<div class="sub">${x.repo} · ${x.lane} ${x.bucket} · ${Age(x.verbAt)}${x.for && [' · ', addrCell(x)]} ${prCell(x)}</div>`,
    session,
    x.worker && html`<${WorkerDetails} worker=${x.worker} headless=${!x.claimedBy?.startsWith('wt:')} />`,
    x.worktree && [
      html`<div class="sec">worktree${x.worktreeOf ? ' (reused from ' + x.worktreeOf.slice(0, 8) + ')' : ''}</div>`,
      cmdRow(x.worktree),
      x.worktreeKept && html`<div class="dim" style="font-size:11px">kept: ${x.worktreeKept}</div>`,
    ],
    x.transcript && [html`<div class="sec">transcript</div>`, cmdRow(x.transcript)],
    report && reportLink(report),
    detailBody(x, detail),
  ];
}

function trapModal(t: GlassTrap) {
  const r = trapRow(t);
  const sub = t.requested
    ? [
        t.repo ?? '',
        ' · ',
        t.harness ?? '',
        ' · requested ',
        Age(t.requested.at),
        ' ago from the glass; the helm starts it with man throw --new.',
      ]
    : t.starting
      ? t.starting.failedAt
        ? [
            t.repo ?? '',
            ' · reserved ',
            Age(t.starting.reservedAt),
            ' ago · start failed: ',
            t.starting.reason ?? '',
            '. Its addressed work stays queued; a session can still redeem the ticket, or `lobstah stow --wt ',
            t.name ?? t.trapId,
            '` withdraws it.',
          ]
        : [
            t.repo ?? '',
            ' · reserved ',
            Age(t.starting.reservedAt),
            ' ago · starting: waiting for a session to redeem the ticket (due by ',
            t.starting.deadline,
            ')',
          ]
      : t.live
        ? [
            t.repo ?? 'addressed bait only',
            ' · session ',
            t.sessionId ?? '',
            ' · signed on ',
            Age(t.signedOnAt),
            ' ago · ',
            r.listen,
            ' · heartbeat ',
            r.hb,
          ]
        : 'signed off — registration gone; the lifecycle, messages, and catches are the surviving record. Re-soaking the same worktree restores this address.';
  const lifecycle = t.notices.length
    ? t.notices.map((n) => html`<div key=${n.seq} class="loglines">${Age(n.at)} ago · <b>${n.kind}</b> — ${n.text}</div>`)
    : html`<div class="empty">none recorded</div>`;
  const messages = t.messages.length
    ? t.messages.map(
        (m) =>
          html`<div key=${m.file} class=${'msg' + (m.from === 'helm' ? ' from-helm' : '')}><div class="hdr">from ${m.from} · ${m.at && [Age(m.at), ' ago']} · ${m.state === 'pending' ? html`<span class="warn">pending</span>` : html`<span class="ok">delivered</span>`}</div>${m.text}${m.attachments?.length ? attachmentRows(m.attachments, (name) => trapFileUrl(t.trapId, name)) : ''}</div>`,
      )
    : html`<div class="empty">none</div>`;
  // Each catch's last note; its modal has the whole log.
  const catches = t.catches.length
    ? t.catches.map(
        (c) =>
          html`<div key=${c.lane + ':' + c.id} class="catch click" onClick=${opener('dispatch', c.lane + ':' + c.id)}><div class="hdr"><b>${c.id.slice(0, 8)}</b><span class=${'badge v-' + c.verb}>${c.verb}</span><span class="dim">${Age(c.verbAt)}</span>${prCell(c)}</div>${
            c.note && html`<div class="loglines">${NamedText(c.note)}</div>`
          }</div>`,
      )
    : html`<div class="empty">none yet</div>`;
  return [
    close,
    html`<h3>🪤 ${t.label ?? `wt:${t.trapId}`} <span class="badge">${t.requested ? 'requested' : t.starting ? (t.starting.failedAt ? 'start failed' : 'starting') : t.live ? 'live' : 'signed off'}</span></h3>`,
    html`<${WorkerDetails} worker=${t} />`,
    t.worktree && html`<div class="sub">${t.worktree}</div>`,
    html`<div class="sub">${sub}</div>`,
    html`<div class="sec">window</div>`,
    windowAction(t),
    startCommands(t),
    t.live &&
      !(t.link && desktopSession(t)) &&
      t.sessionId && [
        html`<div class="sec">open this session</div>`,
        resumeRow(t),
        html`<div class="dim" style="font-size:11px">as registered at sign-on — a hookless enlistment may hold a made-up id</div>`,
      ],
    html`<div class="sec">lifecycle (${t.notices.length})</div>`,
    lifecycle,
    html`<div class="sec">messages (${t.messages.length})</div>`,
    messages,
    html`<div class="sec">catches (${t.catches.length})</div>`,
    catches,
  ];
}

/** The open modal's body, or nothing. Preact keeps every unchanged node across ticks. */
export function Modal({
  snapshot,
  modal,
  prefs,
  detail = null,
}: {
  snapshot: GlassSnapshot | undefined;
  modal: ModalRef | null;
  prefs: GlassPrefs;
  detail?: DispatchDetail | null;
}) {
  if (!snapshot || !modal) return null;
  const item = modalItem(snapshot, modal, detail);
  // A dispatch the poll left out: its detail is on its way.
  if (!item && modal.type === 'dispatch' && detail?.key === modal.key)
    return [
      close,
      html`<h3>${modal.key.slice(modal.key.indexOf(':') + 1, modal.key.indexOf(':') + 9)}</h3>`,
      html`<div class=${detail.error ? 'bad' : 'dim'}>${detail.error ?? 'loading…'}</div>`,
    ];
  if (!item) return null;
  if (modal.type === 'settings') return settingsModal(item as SettingsItem, prefs);
  if (modal.type === 'pr') return prModal(snapshot, modal.key);
  if (modal.type === 'helm') return helmModal(item as GlassHelm);
  if (modal.type === 'dispatch') {
    const report = dispatchReport(snapshot, item as GlassDispatchSummary);
    return dispatchModal(item as GlassDispatchSummary, report, detail);
  }
  return trapModal(item as GlassTrap);
}
