import type { GlassRunCard, ScriptWarning } from '@lobstah/core';
import { can } from '../backend.js';
import { html } from '../html.js';

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
export function runBlocked(run: GlassRunCard): string | undefined {
  if (run.altered) return "The stored script no longer matches the card's hash, so it won't run.";
  return 'Set up a passkey in Settings to run cards.';
}

export function RunCardBody({ cardKey, run }: { cardKey: string; run: GlassRunCard }) {
  const blocked = runBlocked(run);
  return html`<div class="runcard" data-run=${cardKey}>
    <div class="runhead"><span class="badge warn">run on this Mac</span>${run.proposedBy && html`<span class="dim"> proposed by ${run.proposedBy}</span>`}</div>
    <${Script} run=${run} />
    <${Warnings} warnings=${run.warnings} />
    <div class="runmeta dim">
      <span>sha256 <code class="runsha">${run.scriptSha256}</code></span>
      <span>runs <code>${run.interpreter}</code> in <code>${run.cwd}</code></span>
      <span>time limit ${limit(run.timeoutSecs)}</span>
      <span>the agent gets ${run.output === 'exit' ? 'the exit code only' : 'the exit code and scrubbed output'}</span>
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
          disabled
          aria-label=${input.name}
        /></label>`,
      )}</div>`
    }
    ${
      can('run') &&
      html`<div class="runfoot"><button type="button" class="btn runbtn" disabled title=${blocked}>Run</button>${!run.altered && html`<span class="dim">${blocked}</span>`}</div>`
    }
  </div>`;
}
