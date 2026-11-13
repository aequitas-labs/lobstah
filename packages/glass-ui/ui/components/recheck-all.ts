import type { HelmPassView } from '@lobstah/core';
import { requestHelmPass } from '../actions.js';
import { can } from '../backend.js';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { Age } from './common.js';
import { Button } from './button.js';
import { ITEM_ICON } from './icons.js';

/** Request a pass on one grounds; its stored request stays visible until the helm delivers it. */
export function RecheckAll({ pass }: { pass: HelmPassView }): Children {
  if (!can('helm-pass-request')) return null;
  const request = (): Promise<string | undefined> => requestHelmPass(pass.grounds);
  return html`<${Button} class="helm-recheck" disabled=${!!pass.requestedAt} title="Asks the helm to go through every todo and goal now" action=${request} sending="Asking…">${pass.requestedAt ? ['Asked ', Age(pass.requestedAt), ' ago'] : [ITEM_ICON.recheck, 'Recheck all']}<//>`;
}
