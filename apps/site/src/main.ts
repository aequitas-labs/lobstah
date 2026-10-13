// The marketing page's script. The page is complete without it: every scene
// is a still picture in the base styles. This file only starts motion that the
// stylesheet has already prepared, and stops it again when nobody can see it.

const root = document.documentElement;
const STILL_KEY = 'lobstah-still';
/** How long the hero waits, in view and idle, before the buoy dips. */
const HERO_BEAT_MS = 3000;

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

/** The hero's one timed event: after a beat in view, the buoy dips and the card rises. Once. */
function heroBeat(hero: Element): (visible: boolean) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (visible) => {
    if (hero.classList.contains('told')) return;
    clearTimeout(timer);
    if (visible) timer = setTimeout(() => hero.classList.add('told'), HERO_BEAT_MS);
  };
}

/**
 * Mark what is on screen. `.in` (set once) starts a scene's play-once motion;
 * `.off` pauses its loops while it is out of view.
 */
function watchScenes(): void {
  const hero = document.querySelector('.hero');
  const beat = hero ? heroBeat(hero) : undefined;
  if (!('IntersectionObserver' in window)) {
    for (const el of document.querySelectorAll('.scene')) el.classList.add('in');
    hero?.classList.add('told');
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        e.target.classList.toggle('off', !e.isIntersecting);
        if (e.target === hero) beat?.(e.isIntersecting);
      }
    },
    { rootMargin: '10% 0px' },
  );
  const played = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        played.unobserve(e.target);
      }
    },
    { threshold: 0.35 },
  );
  for (const el of document.querySelectorAll('.scene')) {
    seen.observe(el);
    played.observe(el);
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
watchScenes();
stillSwitch();
document.addEventListener('visibilitychange', () => root.classList.toggle('hidden', document.hidden));
