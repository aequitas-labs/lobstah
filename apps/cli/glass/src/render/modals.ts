import type { GlassDispatch, GlassHelm, GlassSnapshot, GlassTrap } from '@lobstah/core';
import { modalItem, prBadgeClass, prModalView } from '../../../src/glass-diff.js';
import type { PrModalView, SettingsItem } from '../../../src/glass-diff.js';
import { html, join, raw } from '../html.js';
import type { Html } from '../html.js';
import { st } from '../prefs.js';
import { state } from '../state.js';
import {
  addrCell,
  ageEl,
  attachmentRows,
  cmdRow,
  detailBody,
  logText,
  prChecks,
  prCell,
  prLink,
  prMerge,
  prReview,
  trapRow,
} from './common.js';

/** The overlay's one modal: dispatch, trap, helm, PR, or ⚙ settings. */

const close = raw('<span class="x" onclick="closeModal()">×</span>');

// Per-browser preferences (localStorage, save()); the kinds line is read-only config.
const seg = (name: string, opts: Array<[string, string]>, cur: string) =>
  html`<span class="seg">${opts.map(([v, l]) => html`<button class="${v === cur && 'on'}" onclick="${name}('${v}')">${l}</button>`)}</span>`;

function settingsModal(item: SettingsItem): Html {
  const view = seg(
    'setView',
    [
      ['table', 'table'],
      ['cards', 'cards'],
    ],
    st.view,
  );
  const lobs = seg(
    'setLobs',
    [
      ['on', 'on'],
      ['off', 'off'],
    ],
    st.lobs ? 'on' : 'off',
  );
  const kinds = item.attentionError ? item.attentionError : (item.attentionKinds || []).join(' · ');
  return html`${close}<h3>⚙ settings <span class="dim" style="font-weight:normal">· this browser only</span></h3><div class="settings"><div class="row"><span class="lbl">view<span class="hint">cards or table (notices stay a table)</span></span>${view}</div><div class="row"><span class="lbl">lobs<span class="hint">crawling lobsters in this page</span></span>${lobs}</div><div class="row"><span class="lbl">attention<span class="hint">kinds shown — attentionKinds in config.toml (read-only here)</span></span><span class="dim" style="font-size:11px;text-align:right;max-width:260px">${kinds}</span></div></div>`;
}

function stackLine(p: PrModalView['pr'], s: NonNullable<PrModalView['stack']>): Html {
  const numbers = join(
    s.numbers.map((n) => (n === p.number ? html`<b>#${n}</b>` : '#' + n)),
    ' → ',
  );
  const next = s.nextMergeable
    ? raw(' · <span class="ok">next mergeable</span>')
    : s.blockedBy
      ? ` · blocked by #${s.blockedBy}`
      : s.nextNumber
        ? ` · next is #${s.nextNumber}`
        : '';
  return html`${numbers} · ${s.position} of ${s.size} · floor ${s.floor}${next}`;
}

function prModal(d: GlassSnapshot, key: string): Html {
  const v = prModalView(d, key)!,
    p = v.pr,
    s = v.stack,
    w = v.watch;
  const review = prReview(p);
  const draft = p.draft && p.badge.text !== 'draft' && raw(' <span class="badge pr-draft">draft</span>');
  const chain = v.chain.length
    ? join(
        v.chain.map((c) =>
          c.culled
            ? html`<span class="dim">${c.id.slice(0, 8)} (culled)</span>`
            : html`<a href="#" onclick="event.preventDefault();showModal('dispatch','${c.modalKey}')">${c.id.slice(0, 8)}</a> <span class="dim">${c.verb}</span>`,
        ),
        ' → ',
      )
    : raw('<span class="dim">none</span>');
  const watch = w
    ? html`<div>${w.key} · owner ${w.owner || '?'} · ${w.lastCheckedAt ? html`checked ${ageEl(w.lastCheckedAt)} ago` : 'never checked'}</div>${w.lastError && html`<div class="bad">${w.lastError}</div>`}<div class="dim" style="font-size:11px;margin-top:4px">cursor</div>${cmdRow(w.cursor)}`
    : html`<div class="dim">no watch — <code>lobstah watch add ${p.url}</code> registers one</div>`;
  return html`${close}<h3>${prLink(p)} ${p.title || ''} <span class="badge ${prBadgeClass(p.badge)}">${p.badge.text}</span>${draft}</h3><div class="sub">${p.repo} · ${p.state} · observed ${ageEl(p.observedAt)} ago${p.gate && html` · gate ${p.gate}`}</div><div class="sec">checks</div><div>${prChecks(p)}</div><div class="sec">review</div><div>${review.value ? review : raw('<span class="dim">no review yet</span>')}</div><div class="sec">merge</div><div>${prMerge(p)}</div><div class="sec">refs</div><div>${p.headRefName || '?'} → ${p.baseRefName || '?'}</div><div class="sec">stack</div><div>${s ? stackLine(p, s) : raw('<span class="dim">not stacked</span>')}</div><div class="sec">dispatch chain</div><div>${chain}</div><div class="sec">watch</div>${watch}`;
}

const resumeCmd = (harness: string | undefined, sessionId: string) =>
  (harness === 'codex' ? 'codex resume ' : 'claude --resume ') + sessionId;

function helmModal(h: GlassHelm): Html {
  const stale = Date.now() - Date.parse(h.heartbeatAt) > 1800000;
  const open = h.sessionId && html`<div class="sec">open this session</div>${cmdRow(resumeCmd(h.harness, h.sessionId))}`;
  const transcript = h.transcript && html`<div class="sec">transcript</div>${cmdRow(h.transcript)}`;
  return html`${close}<h3>⛵ ${h.man}</h3><div class="sub">helm of <b>${h.grounds}</b> (${(h.repos || []).join(', ')})</div><div class="sub">${h.harness ?? '?'} · ${h.cwd ?? '?'}${h.host && html` · ${h.host}`}</div><div class="sub">session ${h.sessionId ?? ''} · signed on ${ageEl(h.signedOnAt)} ago · heartbeat <span class="${stale ? 'warn' : 'ok'}">${ageEl(h.heartbeatAt)} ago</span></div>${open}${transcript}`;
}

function dispatchModal(x: GlassDispatch): Html {
  const session =
    x.claimedBy && x.claimedBy.startsWith('wt:')
      ? html`<div class="sec">worked by trap</div>${cmdRow(x.claimedBy)}<div class="dim" style="font-size:11px">an opted-in interactive session mans this seat — attach would resume someone's live thread. Message it instead: lobstah send ${x.claimedBy} "…"</div>`
      : html`<div class="sec">open this session</div>${cmdRow('lobstah attach ' + x.id)}`;
  const transcript = x.transcript && html`<div class="sec">transcript</div>${cmdRow(x.transcript)}`;
  return html`${close}<h3>${x.id.slice(0, 8)} <span class="badge v-${x.verb}">${x.verb}</span></h3><div class="sub">${x.repo} · ${x.lane} ${x.bucket} · ${ageEl(x.verbAt)}${x.for && html` · ${addrCell(x)}`} ${prCell(x)}</div>${session}${transcript}${detailBody(x)}`;
}

function trapModal(t: GlassTrap): Html {
  const r = trapRow(t);
  const sub = t.live
    ? html`${t.repo ?? 'addressed bait only'} · session ${t.sessionId ?? ''} · signed on ${ageEl(t.signedOnAt)} ago · ${r.listen} · heartbeat ${r.hb}`
    : 'signed off — registration gone; the lifecycle, messages, and catches are the surviving record. Re-soaking the same worktree restores this address.';
  const open =
    t.live &&
    t.sessionId &&
    html`<div class="sec">open this session</div>${cmdRow(resumeCmd(t.harness, t.sessionId))}<div class="dim" style="font-size:11px">as registered at sign-on — a hookless enlistment may hold a made-up id</div>`;
  const lifecycle = t.notices.length
    ? t.notices.map((n) => html`<div class="loglines">${ageEl(n.at)} ago · <b>${n.kind}</b> — ${n.text}</div>`)
    : raw('<div class="empty">none recorded</div>');
  const messages = t.messages.length
    ? t.messages.map((m) => {
        const state = m.state === 'pending' ? raw('<span class="warn">pending</span>') : raw('<span class="ok">delivered</span>');
        return html`<div class="msg${m.from === 'helm' && ' from-helm'}"><div class="hdr">from ${m.from} · ${m.at && html`${ageEl(m.at)} ago`} · ${state}</div>${m.text}${m.attachments?.length ? attachmentRows(m.attachments) : ''}</div>`;
      })
    : raw('<div class="empty">none</div>');
  const catches = t.catches.length
    ? t.catches.map(
        (c) =>
          html`<div class="catch"><div class="hdr"><b>${c.id.slice(0, 8)}</b><span class="badge v-${c.verb}">${c.verb}</span><span class="dim">${ageEl(c.verbAt)}</span>${prCell(c)}</div><div class="loglines">${logText(c)}</div></div>`,
      )
    : raw('<div class="empty">none yet</div>');
  return html`${close}<h3>🪤 wt:${t.trapId} <span class="badge">${t.harness ?? 'signed off'}</span></h3>${t.worktree && html`<div class="sub">${t.worktree}</div>`}<div class="sub">${sub}</div>${open}<div class="sec">lifecycle (${t.notices.length})</div>${lifecycle}<div class="sec">messages (${t.messages.length})</div>${messages}<div class="sec">catches (${t.catches.length})</div>${catches}`;
}

/** Rebuild the open modal (or close the overlay when there is none, or its item is gone). */
export function renderModal(d: GlassSnapshot): void {
  const box = document.getElementById('modalbox')!;
  const ov = document.getElementById('overlay')!;
  const modal = state.modal;
  if (!modal) {
    ov.classList.remove('open');
    return;
  }
  const item = modalItem(d, modal);
  if (!item) {
    state.modal = null;
    ov.classList.remove('open');
    return;
  }
  let body: Html;
  if (modal.type === 'settings') body = settingsModal(item as SettingsItem);
  else if (modal.type === 'pr') body = prModal(d, modal.key);
  else if (modal.type === 'helm') body = helmModal(item as GlassHelm);
  else if (modal.type === 'dispatch') body = dispatchModal(item as GlassDispatch);
  else body = trapModal(item as GlassTrap);
  // The overlay is the scroll container; keep the reader's place across a rebuild.
  const top = ov.scrollTop,
    boxTop = box.scrollTop;
  box.innerHTML = body.value;
  ov.classList.add('open');
  ov.scrollTop = top;
  box.scrollTop = boxTop;
}
