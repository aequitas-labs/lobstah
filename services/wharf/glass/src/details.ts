import { useEffect, useState } from 'preact/hooks';
import { MarkdownElements } from '../../../../apps/cli/glass/src/components/markdown.js';
import { safeHref } from '../../../../apps/cli/src/glass-markdown.js';
import { fileText, fileUrl, json } from './api.js';
import { Files, html, OwnedImage, Session, value, when } from './common.js';
import type { Action } from './common.js';
import type { Detail, DispatchView, WharfDocument, Worker } from './model.js';
export function Document({ doc, action, kind = 'documents' }: { doc: WharfDocument; action: Action; kind?: 'documents' | 'dispatches' }) {
  const [text, setText] = useState<string>(),
    [error, setError] = useState(''),
    [option, setOption] = useState(''),
    [answer, setAnswer] = useState('');
  useEffect(() => {
    let live = true;
    setText(undefined);
    setError('');
    if (doc.markdown)
      fileText(fileUrl(kind, doc.id, doc.markdown.id)).then(
        (t) => {
          if (live) setText(t);
        },
        (e: Error) => {
          if (live) setError(e.message);
        },
      );
    return () => {
      live = false;
    };
  }, [doc.id, doc.markdown?.id, kind]);
  const submit = async (e: Event) => {
    e.preventDefault();
    await action(`documents/${doc.id}/answer`, { ...(option ? { option } : {}), ...(answer.trim() ? { text: answer.trim() } : {}) });
  };
  return html`<div class="sub">${doc.kind} · ${doc.author} · ${when(doc.at)}</div>
    ${
      doc.markdown &&
      html`<div class="mdpage">${
        text !== undefined
          ? html`<${MarkdownElements} text=${text} image=${(name: string, alt: string) => {
              const matches = doc.attachments.filter((f) => f.name === name);
              const f = matches.length === 1 ? matches[0] : undefined;
              return f
                ? html`<${OwnedImage} file=${f} document=${doc.id} alt=${alt} kind=${kind} />`
                : html`<span class="dim">[image not shown: ${alt}]</span>`;
            }} />`
          : error || 'loading…'
      }</div>`
    }
    <${Files} files=${doc.attachments} kind=${kind} id=${doc.id} />
    ${doc.kind === 'decision' && (doc.answer ? html`<div class="ok">answered: ${doc.answer.option} ${doc.answer.text}</div>` : html`<form onSubmit=${submit}><div class="doptions">${doc.options?.map((o) => html`<button type="button" class=${'btn dopt' + (option === o ? ' on' : '')} aria-pressed=${option === o} onClick=${() => setOption(o)}>${o}</button>`)}</div><textarea class="danswer" aria-label="answer" maxLength="20000" value=${answer} onInput=${(e: Event) => setAnswer(value(e))}></textarea><button class="btn" disabled=${!option && !answer.trim()}>answer card</button></form>`)}
  `;
}
export function Job({ job, workers, action }: { job: DispatchView; workers: Worker[]; action: Action }) {
  const [detail, setDetail] = useState<Detail>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let live = true;
    json<Detail>(`/api/glass/dispatches/${job.id}/detail`).then(
      (d) => {
        if (live) setDetail(d);
      },
      (e: Error) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [job.id, job.status?.at, job.state]);
  const worker = workers.find((w) => w.id === job.workerId);
  const reports =
    detail?.reports.flatMap((s) => {
      const files = detail.files.filter((f) => s.evidence?.files?.includes(f.id));
      const markdown = files.find((f) => f.name === 'report.md' && f.size <= 65536);
      return markdown
        ? [
            {
              id: job.id,
              kind: 'report' as const,
              title: 'Worker report',
              author: job.workerId ?? 'headless worker',
              at: s.at,
              published: true,
              markdown,
              attachments: files.filter((f) => f.id !== markdown.id),
            },
          ]
        : [];
    }) ?? [];
  return html`<div class="sub">${job.id} · ${job.repo} · ${job.status?.verb ?? job.state} · ${job.boatName ?? worker?.boatName ?? 'boat unknown'}</div>
    <div class="sec">brief</div><pre>${job.brief}</pre>
    <div class="sec">status notes / catches</div>${error && html`<div class="bad">${error}</div>`}${detail?.reports.map((s) => html`<div class="catch"><div class="hdr"><b>${s.verb}</b><span class="dim">${when(s.at)}</span></div><pre>${s.note}</pre>${s.waitingOn && html`<div class="waiting">waiting on ${s.waitingOn}${s.until ? ' until ' + s.until : ''}</div>`}${s.evidence?.prUrls?.map((url) => safeHref(url) && html`<div><a href=${safeHref(url)} target="_blank" rel="noopener noreferrer">${url}</a></div>`)}</div>`)}
    <div class="sec">messages</div>${detail?.messages.map((m) => html`<div class="msg"><div class="hdr">${m.received ? 'received' : 'unread'}</div>${m.text}</div>`)}
    <${Files} files=${detail?.files ?? []} kind="dispatches" id=${job.id} />
    ${reports.map((r) => html`<div class="sec">worker report</div><${Document} key=${r.markdown.id} doc=${r} action=${action} kind="dispatches" />`)}
    ${
      !['done', 'cancelled'].includes(job.state) &&
      html`<form onSubmit=${async (e: Event) => {
        e.preventDefault();
        if (await action('requests', { id: crypto.randomUUID(), kind: 'message', dispatch: job.id, text: message })) setMessage('');
      }}><textarea class="danswer" aria-label="message to helm" maxLength="16000" value=${message} onInput=${(e: Event) => setMessage(value(e))}></textarea><button class="btn" disabled=${!message.trim()}>queue message for helm</button></form><div class="sec">cancel</div>${confirm ? html`<div>Cancel this job and fence its worker?<button class="btn" onClick=${() => action(`dispatches/${job.id}/cancel`, {})}>confirm cancel</button><button class="btn" onClick=${() => setConfirm(false)}>keep job</button></div>` : html`<button class="btn" onClick=${() => setConfirm(true)}>cancel job…</button>`}`
    }
    ${worker && html`<${Session} worker=${worker} />`}
  `;
}
