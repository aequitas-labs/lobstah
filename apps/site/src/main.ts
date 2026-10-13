// The marketing page's script. The page reads without it: the scene then
// stands at its first frame and every word is still there. This file tells the
// scene which beat of the story is on screen, pauses loops nobody can see, and
// runs the copy buttons and the "still water" switch.

const root = document.documentElement;
const STILL_KEY = 'lobstah-still';

function copyButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy ?? '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // No clipboard permission (an insecure origin, an old browser): select the command instead.
        const code = btn.parentElement?.querySelector('code');
        if (code) getSelection()?.selectAllChildren(code);
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
  // A beat is current once its caption has reached the middle of the screen.
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
  for (const el of document.querySelectorAll('.story, .strip')) seen.observe(el);
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
stillSwitch();
if ('IntersectionObserver' in window) {
  const story = document.querySelector<HTMLElement>('.story');
  if (story) followBeats(story);
  pauseOffScreen();
}
document.addEventListener('visibilitychange', () => root.classList.toggle('hidden', document.hidden));
