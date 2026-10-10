import { useState } from 'preact/hooks';
import { json } from './api.js';
import { html, value } from './common.js';
type Device = { boatName: string; previousBoatName?: string; requestedPermissions: string[]; description: string };
export function DeviceApproval({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [device, setDevice] = useState<Device>(),
    [pending, setPending] = useState(false);
  const [code, setCode] = useState(new URLSearchParams(location.search).get('user_code') ?? ''),
    [steering, setSteering] = useState('read');
  const inspect = async (e: Event) => {
    e.preventDefault();
    try {
      const d = await json<Device>(`/api/auth/device?user_code=${encodeURIComponent(code.trim())}`);
      setDevice(d);
      setSteering(d.requestedPermissions.includes('helm') ? 'helm' : d.requestedPermissions.includes('read') ? 'read' : 'none');
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const approve = async (refuse = false) => {
    if (!device || pending) return;
    setPending(true);
    try {
      await json(
        refuse ? '/api/auth/device/deny' : '/api/auth/wharf/approve',
        refuse
          ? { userCode: code.trim() }
          : {
              userCode: code.trim(),
              name: device.boatName,
              requestedPermissions: device.requestedPermissions,
              permissions: steering === 'none' ? ['work'] : ['work', steering],
            },
      );
      setDevice(undefined);
      notify(refuse ? 'boat approval refused' : 'boat approved; return to its terminal');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setPending(false);
    }
  };
  return html`<div class="sec">approve this boat</div><form onSubmit=${inspect}><label>code <input aria-label="boat approval code" maxLength="128" value=${code} onInput=${(
    e: Event,
  ) => {
    setCode(value(e));
    setDevice(undefined);
  }} /></label><button class="btn">inspect request</button></form>${device && html`<div class="card"><div class="top"><b>${device.boatName}</b></div><div class="note">${device.previousBoatName && 'previously ' + device.previousBoatName + ' · '}${device.description}</div><label>approved access <select aria-label="approved boat access" value=${steering} onChange=${(e: Event) => setSteering(value(e))}><option value="none">work only</option>${device.requestedPermissions.includes('read') || device.requestedPermissions.includes('helm') ? html`<option value="read">work + read</option>` : null}${device.requestedPermissions.includes('helm') && html`<option value="helm">work + helm</option>`}</select></label><div class="foot"><button class="btn" disabled=${pending} onClick=${() => approve()}>approve ${device.boatName}</button><button class="btn" disabled=${pending} onClick=${() => approve(true)}>refuse</button></div></div>`}`;
}
