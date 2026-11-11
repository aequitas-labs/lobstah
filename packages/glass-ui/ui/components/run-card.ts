import type { GlassRunCard, ScriptWarning } from '@lobstah/core';
import { can } from '../backend.js';
import { html } from '../html.js';
import { getState } from '../store.js';
import type { RunView } from '../store.js';
import { dismissRunCard, followRunCard, passkeysWorkHere, runPasskeyUrl, runRunCard, sendRunLine, stopRunCard } from '../actions.js';
import { useEffect, useState } from 'preact/hooks';

/**
 * A run card's body in the decision modal: the script in full, with every
 * character a reader could miss shown and named; what runs it, where, for
 * how long, and what the agent gets back; one field per declared input; and
 * Run. The script is the stored copy the glass would run, never a summary.
 * Run renders only where the source runs things (the local glass): the
 * hosted glass on the wharf shows the card without it.
 */

/** A minute count for a time limit: `5m`, or seconds under a minute. */
const limit = (secs: number): string => (secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`);

/** One script line, with each flagged character replaced by a visible, named mark. */
function scriptLine(text: string, lineNo: number, warnings: ScriptWarning[]) {
  const marks = warnings.filter((w) => w.line === lineNo);
  if (!marks.length) return text;
  const out: unknown[] = [];
  let column = 0;
  let run = '';
  for (const ch of text) {
    column += 1;
    const w = marks.find((m) => m.column === column);
    if (!w) {
      run += ch;
      continue;
    }
    if (run) out.push(run);
    run = '';
    // A visible stand-in: invisible and direction-changing characters can't redraw the line.
    const shown = w.kind === 'non-ascii' ? ch : '';
    out.push(
      html`<mark class=${'runwarn ' + w.kind} title=${`${w.codePoint} ${w.name}`}>${shown}<span class="runcp">${w.codePoint}</span></mark>`,
    );
  }
  if (run) out.push(run);
  return out;
}

/** The script, line by line, as a code block. */
function Script({ run }: { run: GlassRunCard }) {
  const lines = run.script.replace(/\n$/, '').split('\n');
  return html`<pre class="runscript"><code>${lines.map((l, i) => html`<span key=${i} class="runline">${scriptLine(l, i + 1, run.warnings)}${'\n'}</span>`)}</code></pre>`;
}

/** Each flagged character by line and column, named. */
function Warnings({ warnings }: { warnings: ScriptWarning[] }) {
  if (!warnings.length) return null;
  return html`<div class="runwarnings bad" role="note"><b>${warnings.length} character${warnings.length === 1 ? '' : 's'} to check:</b><ul>${warnings.map(
    (w, i) => html`<li key=${i}>line ${w.line}, column ${w.column}: <code>${w.codePoint}</code> ${w.name}</li>`,
  )}</ul></div>`;
}

/** Why Run can't be pressed yet, or undefined when it can. */
export function runBlocked(run: GlassRunCard, passkeys = getState().snapshot?.runPasskeys?.count ?? 0): string | undefined {
  if (run.altered) return "The stored script no longer matches the card's hash, so it won't run.";
  if (!passkeys) return 'Set up a passkey in Settings to run cards.';
  return undefined;
}

/**
 * The secret lines sent from this tab, by card key, so the eye beside each
 * can show it again. Only this module's memory holds them: not the store,
 * browser storage, the URL, or any request but the one that sent the line.
 * A reload, another tab or another device has none, and shows no eye.
 */
const sentSecrets = new Map<string, string[]>();

/** What a hidden secret shows: the same length whatever the value, so it gives away nothing. */
const SECRET_MASK = '••••••••';

/** The eye that shows or hides a secret; slashed while the secret shows. */
function Eye({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const label = shown ? 'Hide secret' : 'Show secret';
  return html`<button type="button" class="runeye" aria-label=${label} title=${label} onClick=${onToggle}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />${shown ? html`<path d="M3 3l18 18" />` : null}</svg></button>`;
}

/** A secret line sent from this tab: masked until its eye shows it. */
function SentSecret({ value, n }: { value: string; n: number }) {
  const [shown, setShown] = useState(false);
  return html`<li class="runsentline">
    <span class="dim runsentname">› secret line ${n}</span>
    <code class="runsentval">${shown ? value : SECRET_MASK}</code>
    <${Eye} shown=${shown} onToggle=${() => setShown(!shown)} />
  </li>`;
}

/**
 * The console line under an interactive run's output: Chris answers at the
 * prompt, Enter sends the line, and the secret toggle masks it and has the
 * glass scrub its value from everything printed after. A secret line has
 * the eye to check it before it goes; once sent, `onSent` hands it to the
 * card so its eye can show it again.
 */
function ConsoleLine({ cardKey, onSent }: { cardKey: string; onSent: (secret: string) => void }) {
  const [line, setLine] = useState('');
  const [secret, setSecret] = useState(false);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const send = async () => {
    const text = line;
    const masked = secret;
    setLine('');
    setShown(false);
    const refused = await sendRunLine(cardKey, text, masked);
    setError(refused);
    if (!refused && masked && text) onSent(text);
  };
  return html`<div class="runconsole">
    <div class="runprompt"><span aria-hidden="true">›</span><input
      type=${secret && !shown ? 'password' : 'text'}
      class="runlinein"
      autocomplete="off"
      spellcheck="false"
      aria-label="Answer the script"
      placeholder=${secret ? 'secret answer' : 'answer'}
      value=${line}
      onInput=${(e: Event) => setLine((e.currentTarget as HTMLInputElement).value)}
      onKeyDown=${(e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        void send();
      }}
    />${secret && html`<${Eye} shown=${shown} onToggle=${() => setShown(!shown)} />`}</div>
    <button type="button" class=${'btn runsecret' + (secret ? ' on' : '')} aria-pressed=${secret ? 'true' : 'false'} title="Mask this line and scrub its value from the output" onClick=${() => {
      setSecret(!secret);
      setShown(false);
    }}>secret</button>
    <span class="dim">Enter sends the line</span>
    ${error && html`<span class="bad">${error}</span>`}
  </div>`;
}

/** The run's scrubbed output on the card, how it ended, the secret lines sent from this tab, and the console line while an interactive run waits. */
function RunOutput({ view, cardKey, interactive }: { view: RunView | undefined; cardKey: string; interactive: boolean }) {
  // Re-render when a secret line is sent: the list lives outside the store, in sentSecrets.
  const [, setSentCount] = useState(0);
  if (!view || (!view.busy && !view.output && !view.result && !view.error)) return null;
  const sent = sentSecrets.get(cardKey) ?? [];
  const onSent = (value: string) => {
    sentSecrets.set(cardKey, [...(sentSecrets.get(cardKey) ?? []), value]);
    setSentCount((n) => n + 1);
  };
  const ended =
    view.result &&
    (view.result.timedOut
      ? `Failed · timed out · exit 124`
      : view.result.stopped
        ? 'Stopped'
        : `${view.result.exitCode === 0 ? 'Succeeded' : 'Failed'} · exit ${view.result.exitCode}`);
  return html`<div class="runout">
    <div class="runstate">${view.busy ? html`<span class="warn">Running…</span>` : ended && html`<span class=${view.result!.exitCode === 0 ? 'ok' : 'bad'}>${ended}</span>`}${view.result?.scrubbed ? html`<span class="dim"> · ${view.result.scrubbed} value${view.result.scrubbed === 1 ? '' : 's'} scrubbed</span>` : null}</div>
    ${view.startedAt && html`<div class="dim">Started ${new Date(view.startedAt).toLocaleString()}</div>`}
    ${view.finishedAt && html`<div class="dim">Finished ${new Date(view.finishedAt).toLocaleString()}</div>`}
    ${(view.output || (interactive && view.busy)) && html`<pre class="runscript runlog"><code>${view.output}</code></pre>`}
    ${sent.length > 0 && html`<ul class="runsent" aria-label="Secret lines sent from this tab">${sent.map((value, i) => html`<${SentSecret} key=${i} value=${value} n=${i + 1} />`)}</ul>`}
    ${interactive && view.busy && html`<${ConsoleLine} cardKey=${cardKey} onSent=${onSent} />`}
    ${view.error && html`<div class="bad">${view.error}</div>`}
  </div>`;
}

export function RunCardBody({ cardKey, run, readOnly = false }: { cardKey: string; run: GlassRunCard; readOnly?: boolean }) {
  const blocked = runBlocked(run);
  // Typed values live only in this component until Run sends them, then they are cleared.
  const [values, setValues] = useState<Record<string, string>>({});
  const saved = run.latest;
  const local = getState().runs?.[cardKey];
  const restored = saved
    ? {
        busy: saved.state === 'running',
        output: '',
        next: 0,
        result: saved.result,
        startedAt: saved.startedAt,
        finishedAt: saved.finishedAt,
      }
    : undefined;
  // A failed output poll must still offer Stop while the saved attempt is running.
  const view =
    local?.error && !local.result && restored ? { ...local, ...restored, output: local.output, error: local.error } : (local ?? restored);
  useEffect(() => {
    if (saved && can('run')) void followRunCard(cardKey);
  }, [cardKey, saved?.id, saved?.state]);
  const here = passkeysWorkHere();
  const missing = run.inputs.filter((i) => !values[i.name]).map((i) => i.name);
  const locked = readOnly || !!blocked || !!view?.busy;
  const start = () => {
    const inputs = values;
    setValues({});
    sentSecrets.delete(cardKey);
    void runRunCard(cardKey, run.scriptSha256, inputs);
  };
  return html`<div class="runcard" data-run=${cardKey}>
    <div class="runhead"><span class="badge warn">run on this Mac</span>${run.proposedBy && html`<span class="dim"> proposed by ${run.proposedBy}</span>`}</div>
    <${Script} run=${run} />
    <${Warnings} warnings=${run.warnings} />
    <div class="runmeta dim">
      <span>sha256 <code class="runsha">${run.scriptSha256}</code></span>
      <span>runs <code>${run.interpreter}</code> in <code>${run.cwd}</code></span>
      <span>time limit ${limit(run.timeoutSecs)}</span>
      <span>the agent gets ${run.output === 'exit' ? 'the exit code only' : 'the exit code and scrubbed output'}</span>
      ${run.interactive && html`<span>interactive: answer its prompts here</span>`}
    </div>
    ${run.altered && html`<div class="bad">${blocked}</div>`}
    ${
      run.inputs.length > 0 &&
      html`<div class="runinputs">${run.inputs.map(
        (
          input,
        ) => html`<label key=${input.name} class="runinput"><span class="runname"><code>${input.name}</code> <span class="dim">${input.secret ? 'secret' : 'text'}</span></span><input
          type=${input.secret ? 'password' : 'text'}
          autocomplete="off"
          spellcheck="false"
          disabled=${locked || !can('run') || !here}
          aria-label=${input.name}
          value=${values[input.name] ?? ''}
          onInput=${(e: Event) => setValues({ ...values, [input.name]: (e.currentTarget as HTMLInputElement).value })}
        /></label>`,
      )}</div>`
    }
    ${
      can('run') &&
      (!readOnly || view?.busy) &&
      html`<div class="runfoot">
        ${
          view?.busy
            ? html`<button type="button" class="btn danger" onClick=${() => void stopRunCard(cardKey)}>Stop</button>`
            : here || blocked
              ? html`<button type="button" class="btn runbtn" disabled=${locked || missing.length > 0} title=${blocked ?? (missing.length ? `Fill in ${missing.join(', ')}` : 'Confirm with your passkey and run')} onClick=${start}>${view?.result ? 'Run again' : 'Run'}</button>`
              : html`<a class="btn runbtn" href=${runPasskeyUrl(`#decision/${encodeURIComponent(cardKey)}`)}>${view?.result ? 'Run again from localhost' : 'Run from localhost'}</a>`
        }
        ${view?.result && html`<button type="button" class="btn" onClick=${() => void dismissRunCard(cardKey)}>Dismiss</button>`}
        ${!view?.busy && html`<span class="dim">${blocked ? !run.altered && blocked : here ? 'Confirm with your passkey to run.' : 'Passkeys work from the glass at localhost.'}</span>`}
      </div>`
    }
    ${!view && html`<div class="runstate dim">Ready</div>`}
    <${RunOutput} view=${view} cardKey=${cardKey} interactive=${!!run.interactive} />
  </div>`;
}
