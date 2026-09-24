import type { ModalType } from '../../src/glass-diff.js';
import { startPolling, tick } from './poll.js';
import { hideLobPref, save, st } from './prefs.js';
import { onRoute } from './route.js';
import { state } from './state.js';
import { probeSprite, resetLobs } from './render/lobs.js';

/**
 * The spyglass page's entry point. The markup's inline handlers call the
 * few functions below on window (showModal, closeModal, copyCmd, setView,
 * setLobs, hideLob); everything else is module-scoped.
 */

declare global {
  interface Window {
    copyCmd: (el: HTMLElement, text: string) => Promise<void>;
    showModal: (type: ModalType, key: string) => void;
    closeModal: () => void;
    setView: (v: string) => void;
    setLobs: (v: string) => void;
    hideLob: (key: string, hash: string) => void;
    tog: (k: string) => void;
  }
}

window.copyCmd = async (el, text) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    return;
  }
  if (el.tagName === 'BUTTON') {
    el.textContent = '✓';
    setTimeout(() => {
      el.textContent = '⧉';
    }, 1000);
  } else {
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 1000);
  }
};

probeSprite(() => tick(true));

window.hideLob = (key, hash) => {
  hideLobPref(key, hash);
  resetLobs();
  setTimeout(() => tick(true), 0);
};
window.tog = (k) => {
  state.open.has(k) ? state.open.delete(k) : state.open.add(k);
  tick(true);
};
window.showModal = (type, key) => {
  state.modal = { type, key };
  tick(true);
};
window.closeModal = () => {
  state.modal = null;
  if (state.hashes) delete state.hashes.modal;
  document.getElementById('overlay')!.classList.remove('open');
};
document.getElementById('overlay')!.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'overlay') window.closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.closeModal();
});
// ⚙ opens the settings modal — the same overlay as every other modal (Escape
// and click-outside close it). Its two preferences are this browser's own:
// localStorage via save(); view applies to every tab.
document.getElementById('gearbtn')!.addEventListener('click', () => window.showModal('settings', 'browser'));
window.setView = (v) => {
  if (v !== 'table' && v !== 'cards') return;
  st.view = v;
  save();
  tick(true);
};
window.setLobs = (v) => {
  st.lobs = v === 'on';
  save();
  resetLobs();
  tick(true);
};
const filters: Array<[string, 'lane' | 'repo' | 'verb' | 'noticeKind']> = [
  ['f-lane', 'lane'],
  ['f-repo', 'repo'],
  ['f-verb', 'verb'],
  ['f-kind', 'noticeKind'],
];
for (const [id, key] of filters) {
  const el = document.getElementById(id) as HTMLSelectElement;
  el.value = st[key];
  el.addEventListener('change', () => {
    st[key] = el.value;
    save();
    tick(true);
  });
}
const chain = document.getElementById('f-chain') as HTMLInputElement;
chain.checked = !!st.chain;
chain.addEventListener('change', () => {
  st.chain = chain.checked;
  save();
  tick(true);
});
const q = document.getElementById('f-q') as HTMLInputElement;
q.value = st.q;
q.addEventListener('input', () => {
  st.q = q.value;
  save();
  tick(true);
});
onRoute(() => tick(true));
startPolling();
