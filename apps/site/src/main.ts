// The marketing page's script. This file tells the scene which beat of the
// story is on screen, pauses loops nobody can see, gives each lobster its own
// pace, and runs the copy buttons and the "still water" switch.

const root = document.documentElement;
const STILL_KEY = 'lobstah-still';

/** Copy what the install control is showing: the prompt or commands of its open tab. */
function copyButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-copy-panel]')) {
    btn.addEventListener('click', async () => {
      const box = btn.closest('.handoff');
      const tabs = [...(box?.querySelectorAll<HTMLInputElement>('.tab-input') ?? [])];
      const panel = box?.querySelectorAll('.panel')[tabs.findIndex((t) => t.checked)];
      if (!panel) return;
      try {
        await navigator.clipboard.writeText(panel.textContent ?? '');
      } catch {
        // No clipboard permission (an insecure origin, an old browser): select the text instead.
        getSelection()?.selectAllChildren(panel);
        return;
      }
      btn.textContent = 'copied';
      setTimeout(() => (btn.textContent = 'copy'), 1500);
    });
  }
}

/**
 * Tell the story which beat is on screen. Where the scroll drives the scene
 * directly the stylesheet ignores this; elsewhere it is what moves the scene,
 * by a transition, or by a plain cut when motion is off.
 */
function followBeats(story: HTMLElement): void {
  const beats = [...story.querySelectorAll('.beat')];
  // A beat is current once it has reached the middle of the screen.
  const middle = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) story.dataset.beat = String(beats.indexOf(e.target));
    },
    { rootMargin: '-50% 0px -50% 0px' },
  );
  for (const beat of beats) middle.observe(beat);
}

/** `.off` pauses the loops of anything that is out of view. */
function pauseOffScreen(): void {
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('off', !e.isIntersecting);
  });
  for (const el of document.querySelectorAll('.story, .strip, .fleet, .scroller')) seen.observe(el);
}

/** Each lobster at the foot of the page walks at its own pace, picked afresh on every visit. */
function lobsterPaces(): void {
  for (const lob of document.querySelectorAll<HTMLElement>('.strip .lob')) {
    const pace = 11 + Math.random() * 17;
    lob.style.setProperty('--pace', `${pace.toFixed(1)}s`);
    // A negative head start puts each one somewhere along its walk already.
    lob.style.setProperty('--head', `${(-Math.random() * pace).toFixed(1)}s`);
  }
}

/**
 * Let the integrations row drift by itself. A second copy of the cards follows
 * the first, hidden from screen readers, so the loop has no end to show; the
 * stylesheet moves the row by exactly one copy's width and starts again.
 */
function driftRow(): void {
  for (const row of document.querySelectorAll<HTMLElement>('.scroller')) {
    const track = row.querySelector<HTMLElement>('.row');
    if (!track) continue;
    const cards = [...track.children] as HTMLElement[];
    for (const card of cards) {
      const copy = card.cloneNode(true) as HTMLElement;
      copy.classList.add('copy');
      copy.setAttribute('aria-hidden', 'true');
      track.append(copy);
    }
    const measure = () =>
      track.style.setProperty(
        '--shift',
        `${cards.reduce((w, c) => w + c.offsetWidth, 0) + cards.length * parseFloat(getComputedStyle(track).columnGap || '0')}px`,
      );
    measure();
    addEventListener('resize', measure);
    row.classList.add('auto');
  }
}

/** "Still water": the same still page that reduced motion gives, by hand, remembered in this browser. */
function stillSwitch(): void {
  const btn = document.querySelector<HTMLButtonElement>('#still');
  if (!btn) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = () => btn.setAttribute('aria-pressed', String(!root.classList.contains('motion')));
  show();
  btn.addEventListener('click', () => {
    const still = root.classList.contains('motion');
    root.classList.toggle('motion', !still && !reduced);
    try {
      if (still) localStorage.setItem(STILL_KEY, '1');
      else localStorage.removeItem(STILL_KEY);
    } catch {
      // Storage is off: the choice lasts for this page view.
    }
    show();
  });
}

copyButtons();
lobsterPaces();
driftRow();
stillSwitch();
if ('IntersectionObserver' in window) {
  const story = document.querySelector<HTMLElement>('.story');
  if (story) followBeats(story);
  pauseOffScreen();
}
document.addEventListener('visibilitychange', () => root.classList.toggle('hidden', document.hidden));
