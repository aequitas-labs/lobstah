import { useEffect, useRef, useState } from 'preact/hooks';
import { acked, html, Session, when } from './common.js';
import { Boats } from './boats.js';
import { Document, Job } from './details.js';
import { DeviceApproval } from './device.js';
import { json } from './api.js';
import { requestState } from './model.js';
import { glassWake } from './wake.js';
import { parseRoute, routeHash, TABS } from './route.js';
import type { Item, Tab } from './route.js';
import type { DispatchView, Snapshot } from './model.js';
import { setDecisionBadge } from '../../../../apps/cli/glass/src/app-badge.js';
import { LinkedText } from '../../../../apps/cli/glass/src/components/links.js';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [jobs, setJobs] = useState<DispatchView[]>([]),
    [tab, setTab] = useState<Tab>(() => parseRoute(location.hash).tab);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    if (snapshot || signedOut) void setDecisionBadge(snapshot?.documents.filter((d) => d.kind === 'decision' && d.published && !d.withdrawn && !d.answer).length ?? 0);
  }, [snapshot, signedOut]);
  // The open item comes from the URL (a link from the pet lands on it) and is written back to it.
  const [modal, setItem] = useState<Item | undefined>(() => parseRoute(location.hash).item);
  const setModal = (item?: Item) => {
    setItem(item);
    history.replaceState(null, '', routeHash({ tab, item }));
  };
  const generation = useRef(0);
  const loggedOut = useRef(false);
  const wake = useRef<ReturnType<typeof glassWake>>();
  const busy = useRef(false),
    live = useRef(true);
  const refresh = async () => {
    if (loggedOut.current) return;
    const request = ++generation.current;
    try {
      const [s, j] = await Promise.all([json<Snapshot>('/api/glass'), json<DispatchView[]>('/api/glass/dispatches')]);
      if (live.current && generation.current === request) {
        setSnapshot(s);
        setJobs(j);
        setError('');
        setSignedOut(false);
      }
    } catch (e) {
      if (!live.current || generation.current !== request) return;
      const message = (e as Error).message;
      setError(message);
      if (message.startsWith('Sign in')) {
        loggedOut.current = true;
        wake.current?.close();
        setSignedOut(true);
        setSnapshot(undefined);
        setJobs([]);
      }
    }
  };
  useEffect(() => {
    live.current = true;
    void refresh();
    wake.current = glassWake(() => { if (!loggedOut.current && live.current) void refresh(); });
    wake.current.connect();
    const timer = setInterval(() => { void refresh(); if (!loggedOut.current) wake.current?.connect(); }, 15000);
    // A link opened in this page, or the back button: follow the URL.
    const follow = () => {
      const route = parseRoute(location.hash);
      setTab(route.tab);
      setItem(route.item);
    };
    addEventListener('hashchange', follow);
    return () => {
      live.current = false;
      clearInterval(timer);
      removeEventListener('hashchange', follow);
      wake.current?.close();
    };
  }, []);
  const notify = (message: string, bad = false) => {
    if (bad) setError(message);
    else {
      setNotice(message);
      setError('');
    }
  };
  const action = async (path: string, body: unknown) => {
    if (busy.current) return false;
    busy.current = true;
    setNotice('');
    try {
      await json('/api/glass/' + path, body);
      notify(path === 'requests' ? 'queued for helm; expires in 10 minutes' : 'saved');
      await refresh();
      return true;
    } catch (e) {
      notify((e as Error).message, true);
      return false;
    } finally {
      busy.current = false;
    }
  };
  const authenticate = async () => {
    try {
      const result = await json<{ url: string }>('/api/auth/sign-in/social', { provider: 'github', callbackURL: location.href });
      location.assign(result.url);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const signOut = async () => {
    loggedOut.current = true;
    wake.current?.close();
    generation.current++;
    try {
      await json('/api/auth/sign-out', {});
      setSignedOut(true);
      setSnapshot(undefined);
      setJobs([]);
      setModal(undefined);
    } catch (e) {
      loggedOut.current = false;
      notify((e as Error).message, true);
    }
  };
  const deleteAccount = async () => {
    if (busy.current) return;
    busy.current = true;
    loggedOut.current = true;
    wake.current?.close();
    generation.current++;
    try {
      await json('/api/glass/account', { confirm: true }, 'DELETE');
      setSnapshot(undefined);
      setJobs([]);
      setModal(undefined);
      setSignedOut(true);
      notify('account data deleted');
    } catch (e) {
      loggedOut.current = false;
      notify((e as Error).message, true);
    } finally {
      busy.current = false;
    }
  };
  const selectedJob = modal?.kind === 'job' ? jobs.find((j) => j.id === modal.id) : undefined,
    selectedDoc = snapshot?.documents.find((d) => d.kind === modal?.kind && d.id === modal.id),
    selectedWorker = modal?.kind === 'trap' ? snapshot?.workers.find((w) => w.id === modal.id) : undefined;
  const found = selectedJob ?? selectedDoc ?? selectedWorker;
  // Opening a report is reading it: the wharf records that once, as the local glass does for its own.
  // State only. A failed ack leaves the report unread; the next load of the page tries again.
  const acking = useRef(new Set<string>());
  useEffect(() => {
    if (selectedDoc?.kind !== 'report' || selectedDoc.ack || acking.current.has(selectedDoc.id)) return;
    acking.current.add(selectedDoc.id);
    json(`/api/glass/documents/${selectedDoc.id}/ack`, {}).then(() => refresh(), () => {});
  }, [selectedDoc?.id, selectedDoc?.kind, !!selectedDoc?.ack]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>('[role=dialog]')?.focus();
    return () => previous?.focus();
  }, [modal?.kind, modal?.id, !!snapshot]);
  const keydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setModal(undefined);
    if (e.key === 'Tab') {
      const nodes = Array.from(
        (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],textarea,input,select,[tabindex="0"]',
        ),
      );
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };
  const cards = (kind: 'decision' | 'report') =>
    snapshot?.documents
      .filter((d) => d.kind === kind)
      .map(
        (d) =>
          html`<button class=${'card' + (d.ack ? ' acked' : '')} onClick=${() => setModal({ kind, id: d.id })}><div class="top"><b>${LinkedText(d.title)}</b><span class="badge">${kind === 'decision' ? (d.answer ? 'answered' : 'needs decision') : d.ack ? 'report · read' : 'report'}</span></div><div class="meta">${d.author} · ${when(d.at)}${acked(d.ack)}</div></button>`,
      );
  return html`<div class="headerline"><h1>🦞✨ spyglass <span class="dim">wharf</span></h1>${!signedOut && html`<button class="btn" onClick=${signOut}>sign out</button>`}</div>
    <div class="chips"><span class="chip">helm ${snapshot && !error ? (snapshot.helmLive ? 'live' : 'unknown / no live lease') : 'unknown'}</span><span class="chip dim">polling · 15s · ${jobs.length} jobs</span></div>
    ${error && html`<div class="bad" role="alert">${error}</div>`}${notice && html`<div class="ok" role="status">${notice}</div>`}
    ${
      signedOut
        ? html`<button class="btn" onClick=${authenticate}>sign in with GitHub</button><div class="dim">Invite-only. Sign-in does not take a helm seat.</div>`
        : snapshot &&
          html`<nav class="tabs" aria-label="Spyglass views">${TABS.map((t) => html`<a href=${'#' + t} class=${tab === t ? 'on' : ''} onClick=${() => setTab(t)}>${t}</a>`)}</nav>
      ${tab === 'deck' && html`<h2>Decisions</h2><div class="cards">${cards('decision')}</div><h2>Human requests</h2>${snapshot.requests.map((r) => html`<div class="msg"><b>${r.kind}</b> · ${r.dispatch ?? r.boat} · ${requestState(r)}<div>${LinkedText(r.text ?? r.repo)}</div></div>`)}`}
      ${tab === 'jobs' && html`<div class="cards">${jobs.map((j) => html`<button class=${'card' + (j.ack ? ' acked' : '')} onClick=${() => setModal({ kind: 'job', id: j.id })}><div class="top"><b>${LinkedText(j.brief.split('\n')[0])}</b><span class="badge">${j.status?.verb ?? j.state}</span></div><div class="meta">${j.repo} · ${j.boatName ?? snapshot.boats.find((b) => b.id === j.claimedBoat)?.name ?? j.claimedBoat ?? 'unclaimed'}${acked(j.ack)}</div><div class="note">${LinkedText(j.status?.note ?? j.unservable?.note)}</div></button>`)}</div>`}
      ${tab === 'traps' && html`<div class="cards">${snapshot.workers.map((w) => html`<button class="card" onClick=${() => setModal({ kind: 'trap', id: w.id })}><div class="top"><b>${w.id}</b><span class="badge">${w.harness ?? 'unknown harness'}</span></div><div class="meta">${w.boatName} · ${when(w.lastCheckIn)}</div><div class="note">${w.current ? 'job ' + w.current : 'no current job'} · ${LinkedText(w.repoRemote)}</div></button>`)}</div>`}
      ${tab === 'boats' && html`<${Boats} boats=${snapshot.boats} action=${action} deleteAccount=${deleteAccount} />`}
      ${tab === 'reports' && html`<div class="cards">${cards('report')}${jobs.filter((j) => j.status?.evidence?.files?.length).map((j) => html`<button class="card" onClick=${() => setModal({ kind: 'job', id: j.id })}><div class="top"><b>${LinkedText(j.brief.split('\n')[0])}</b><span class="badge">catch files</span></div><div class="meta">${j.workerId ?? 'headless worker'} · ${when(j.status?.at)}</div></button>`)}</div>`}
      ${location.pathname === '/device' && html`<${DeviceApproval} notify=${notify} />`}`
    }
    ${
      modal &&
      snapshot &&
      html`<div id="overlay" class="open" onClick=${(e: Event) => {
        if (e.target === e.currentTarget) setModal(undefined);
      }}><section class="modal" role="dialog" aria-modal="true" aria-label=${selectedDoc?.title ?? found?.id ?? 'details'} tabindex="-1" onKeyDown=${keydown}><button class="btn x" aria-label="close details" onClick=${() => setModal(undefined)}>×</button>${error && html`<div class="bad" role="alert">${error}</div>`}${notice && html`<div class="ok" role="status">${notice}</div>`}<h3>${LinkedText(selectedDoc?.title ?? found?.id ?? `${modal.kind} ${modal.id}`)}</h3>${!found && html`<div class="dim">No ${modal.kind} with this id is listed on this wharf for your account. It may have been withdrawn or removed.</div>`}${selectedDoc && html`<${Document} key=${selectedDoc.id} doc=${selectedDoc} action=${action} />`}${selectedJob && html`<${Job} key=${selectedJob.id} job=${selectedJob} workers=${snapshot.workers} action=${action} />`}${selectedWorker && html`<div class="sub">${selectedWorker.harness ?? 'unknown harness'} · ${LinkedText(selectedWorker.repoRemote)}</div><${Session} worker=${selectedWorker} />`}</section></div>`
    }
    <footer>🦞✨ lobstah · wharf · PR watches and repair run on your boats</footer>`;
}
