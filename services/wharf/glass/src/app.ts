import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Session, when } from './common.js';
import { Boats } from './boats.js';
import { Document, Job } from './details.js';
import { DeviceApproval } from './device.js';
import { json } from './api.js';
import { requestState } from './model.js';
import { glassWake } from './wake.js';
import type { DispatchView, Snapshot } from './model.js';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [jobs, setJobs] = useState<DispatchView[]>([]),
    [tab, setTab] = useState('deck');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [signedOut, setSignedOut] = useState(false);
  const [modal, setModal] = useState<{ kind: 'job' | 'document' | 'worker'; id: string }>();
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
        setModal(undefined);
      }
    }
  };
  useEffect(() => {
    live.current = true;
    void refresh();
    wake.current = glassWake(() => { if (!loggedOut.current && live.current) void refresh(); });
    wake.current.connect();
    const timer = setInterval(() => { void refresh(); if (!loggedOut.current) wake.current?.connect(); }, 15000);
    return () => {
      live.current = false;
      clearInterval(timer);
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
  const selectedJob = jobs.find((j) => j.id === modal?.id),
    selectedDoc = snapshot?.documents.find((d) => d.id === modal?.id),
    selectedWorker = snapshot?.workers.find((w) => w.id === modal?.id);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>('[role=dialog]')?.focus();
    return () => previous?.focus();
  }, [modal?.id]);
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
          html`<button class="card" onClick=${() => setModal({ kind: 'document', id: d.id })}><div class="top"><b>${d.title}</b><span class="badge">${kind === 'decision' ? (d.answer ? 'answered' : 'needs decision') : 'report'}</span></div><div class="meta">${d.author} · ${when(d.at)}</div></button>`,
      );
  return html`<div class="headerline"><h1>🦞✨ spyglass <span class="dim">wharf</span></h1>${!signedOut && html`<button class="btn" onClick=${signOut}>sign out</button>`}</div>
    <div class="chips"><span class="chip">helm ${snapshot && !error ? (snapshot.helmLive ? 'live' : 'unknown / no live lease') : 'unknown'}</span><span class="chip dim">polling · 15s · ${jobs.length} jobs</span></div>
    ${error && html`<div class="bad" role="alert">${error}</div>`}${notice && html`<div class="ok" role="status">${notice}</div>`}
    ${
      signedOut
        ? html`<button class="btn" onClick=${authenticate}>sign in with GitHub</button><div class="dim">Invite-only. Sign-in does not take a helm seat.</div>`
        : snapshot &&
          html`<nav class="tabs" aria-label="Spyglass views">${['deck', 'jobs', 'traps', 'boats', 'reports'].map((t) => html`<a href=${'#' + t} class=${tab === t ? 'on' : ''} onClick=${() => setTab(t)}>${t}</a>`)}</nav>
      ${tab === 'deck' && html`<h2>Decisions</h2><div class="cards">${cards('decision')}</div><h2>Human requests</h2>${snapshot.requests.map((r) => html`<div class="msg"><b>${r.kind}</b> · ${r.dispatch ?? r.boat} · ${requestState(r)}<div>${r.text ?? r.repo}</div></div>`)}`}
      ${tab === 'jobs' && html`<div class="cards">${jobs.map((j) => html`<button class="card" onClick=${() => setModal({ kind: 'job', id: j.id })}><div class="top"><b>${j.brief.split('\n')[0]}</b><span class="badge">${j.status?.verb ?? j.state}</span></div><div class="meta">${j.repo} · ${j.boatName ?? snapshot.boats.find((b) => b.id === j.claimedBoat)?.name ?? j.claimedBoat ?? 'unclaimed'}</div><div class="note">${j.status?.note ?? j.unservable?.note}</div></button>`)}</div>`}
      ${tab === 'traps' && html`<div class="cards">${snapshot.workers.map((w) => html`<button class="card" onClick=${() => setModal({ kind: 'worker', id: w.id })}><div class="top"><b>${w.id}</b><span class="badge">${w.harness ?? 'unknown harness'}</span></div><div class="meta">${w.boatName} · ${when(w.lastCheckIn)}</div><div class="note">${w.current ? 'job ' + w.current : 'no current job'} · ${w.repoRemote}</div></button>`)}</div>`}
      ${tab === 'boats' && html`<${Boats} boats=${snapshot.boats} action=${action} deleteAccount=${deleteAccount} />`}
      ${tab === 'reports' && html`<div class="cards">${cards('report')}${jobs.filter((j) => j.status?.evidence?.files?.length).map((j) => html`<button class="card" onClick=${() => setModal({ kind: 'job', id: j.id })}><div class="top"><b>${j.brief.split('\n')[0]}</b><span class="badge">catch files</span></div><div class="meta">${j.workerId ?? 'headless worker'} · ${when(j.status?.at)}</div></button>`)}</div>`}
      ${location.pathname === '/device' && html`<${DeviceApproval} notify=${notify} />`}`
    }
    ${
      modal &&
      snapshot &&
      html`<div id="overlay" class="open" onClick=${(e: Event) => {
        if (e.target === e.currentTarget) setModal(undefined);
      }}><section class="modal" role="dialog" aria-modal="true" aria-label=${selectedDoc?.title ?? selectedJob?.id ?? selectedWorker?.id ?? 'details'} tabindex="-1" onKeyDown=${keydown}><button class="btn x" aria-label="close details" onClick=${() => setModal(undefined)}>×</button>${error && html`<div class="bad" role="alert">${error}</div>`}${notice && html`<div class="ok" role="status">${notice}</div>`}<h3>${selectedDoc?.title ?? selectedJob?.id ?? selectedWorker?.id}</h3>${modal.kind === 'document' && selectedDoc && html`<${Document} key=${selectedDoc.id} doc=${selectedDoc} action=${action} />`}${modal.kind === 'job' && selectedJob && html`<${Job} key=${selectedJob.id} job=${selectedJob} workers=${snapshot.workers} action=${action} />`}${modal.kind === 'worker' && selectedWorker && html`<div class="sub">${selectedWorker.harness ?? 'unknown harness'} · ${selectedWorker.repoRemote}</div><${Session} worker=${selectedWorker} />`}</section></div>`
    }
    <footer>🦞✨ lobstah · wharf · PR watches and repair run on your boats</footer>`;
}
