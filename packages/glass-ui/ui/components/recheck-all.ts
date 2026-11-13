import type { HelmPassView } from '@lobstah/core';
import { useState } from 'preact/hooks';
import { requestHelmPass } from '../actions.js';
import { can } from '../backend.js';
import type { Children } from '../html.js';
import { html } from '../html.js';
import { Age } from './common.js';
import { Button } from './button.js';
import { ITEM_ICON } from './icons.js';

/** Request a pass on one grounds; its stored request stays visible until the helm delivers it. */
export function RecheckAll({ pass }: { pass: HelmPassView }): Children {
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!can('helm-pass-request')) return null;
  const request = async (): Promise<void> => setRefusal((await requestHelmPass(pass.grounds)) ?? null);
  return html`<${Button} class="helm-recheck" disabled=${!!pass.requestedAt} title="Asks the helm to go through every todo and goal now" onClick=${request}>${pass.requestedAt ? ['Asked ', Age(pass.requestedAt), ' ago'] : [ITEM_ICON.recheck, 'Recheck all']}<//>${refusal && html`<span class="bad" role="alert">${refusal}</span>`}`;
}
