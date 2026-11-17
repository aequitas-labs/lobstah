import type { GlassTrapView } from '../../src/glass-diff.js';
import { trapPageUrl } from '../../src/glass-diff.js';
import { html, type Children } from '../html.js';
import buoyBody from '../assets/buoy-body-160.webp';
import buoyBodyRetina from '../assets/buoy-body-320.webp';
import { Button } from './button.js';
import { Harness, HoverInfo, opener, trapDisplayName } from './common.js';
import { isIconVerb, RunStatusIcon, VerbIcon, type VerbIconVerb } from './run-status.js';

function trapBuoy(trap: GlassTrapView): Children {
  const current = trap.catches.find((dispatch) => dispatch.id === trap.claimed && dispatch.bucket === 'active');
  const verb: VerbIconVerb = trap.usageLimit
    ? 'limited'
    : current?.verb === 'blocked'
      ? 'blocked'
      : current?.verb === 'needs-decision' || current?.waiting?.on === 'person'
        ? 'needs-decision'
        : current?.waiting
          ? 'paused'
          : current && isIconVerb(current.verb)
            ? current.verb
            : trap.listening
              ? 'queued'
              : 'unknown';
  const state = trap.usageLimit
    ? 'Usage limit'
    : current
      ? verb === 'needs-decision'
        ? 'Needs you'
        : verb === 'paused'
          ? 'Parked'
          : verb
      : trap.listening
        ? 'Listening · idle'
        : 'Idle';
  const truncate = (text: string, limit: number): string => {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
  };
  const progress = [
    state,
    trap.usageLimit?.reason,
    current && truncate(current.title || 'Dispatch in progress', 100),
    current?.note && truncate(current.note, 180),
  ]
    .filter(Boolean)
    .join(' · ');
  const name = trapDisplayName(trap);
  const repo = trap.repo || (trap.configured ? `trap:${trap.configured.profile}` : 'No repo');
  const open = (event: MouseEvent): void => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      opener('trap', trap.trapId)();
    }
  };
  return html`<div key=${trap.trapId} class="trap-buoy">
    <${HoverInfo} cls="trap-buoy-status" text=${progress} focusable=${false}>
      <${Button} variant="icon" label=${progress}><span aria-hidden="true">${!current && !trap.usageLimit && !trap.listening ? html`<${RunStatusIcon} status="stopped" />` : html`<${VerbIcon} verb=${verb} />`}</span><//>
    <//>
    <div class="trap-buoy-figure">
      <span class="trap-buoy-art">
        <a href=${trapPageUrl(trap.trapId)} aria-label=${`Open ${name} · ${repo}`} onClick=${open}>
          <img src=${buoyBody} srcset=${`${buoyBody} 1x, ${buoyBodyRetina} 2x`} alt="" width="40" height="81" />
        </a>
      </span>
      <${Harness} worker=${trap} cls="trap-buoy-harness" compact />
    </div>
    <b class="trap-buoy-name">${name}</b>
    <small class="trap-buoy-repo">${repo}</small>
  </div>`;
}

/** One linked buoy per active trap, with its current work and model available on hover, focus and touch. */
export function TrapOverview({ traps }: { traps: GlassTrapView[] }): Children {
  return traps.length
    ? html`<div class="trap-overview" aria-label="Active traps">${traps.map(trapBuoy)}</div>`
    : html`<div class="empty">No buoys on the water. Your traps are resting.</div>`;
}
