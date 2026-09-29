/**
 * A wall-clock limit that does not run while the worker is paused on
 * something external. It ticks every `tickMs`, adds the elapsed time only
 * when `paused()` is false, and calls `onExpire` once the running time
 * reaches `limitMs`.
 */
export interface WallClock {
  stop(): void;
  /** Running (not paused) milliseconds so far. */
  elapsed(): number;
  /** Current extendible active-work window. */
  window(): number;
}

export function startWallClock(opts: {
  limitMs: number;
  maxMs?: number;
  initialElapsedMs?: number;
  initialWindowMs?: number;
  paused: () => boolean;
  /** A fresh activity event or new HEAD at the window boundary. */
  progress?: () => boolean;
  onTick?: (elapsedMs: number, windowMs: number) => void;
  onExpire: () => void;
  tickMs?: number;
  now?: () => number;
}): WallClock {
  const now = opts.now ?? Date.now;
  const tickMs = Math.max(1, Math.min(opts.tickMs ?? 5000, opts.limitMs));
  let elapsed = opts.initialElapsedMs ?? 0;
  const maxMs = Math.max(opts.limitMs, opts.maxMs ?? opts.limitMs);
  let windowMs = Math.min(maxMs, Math.max(opts.limitMs, opts.initialWindowMs ?? opts.limitMs));
  let last = now();
  let done = false;
  const check = () => {
    const t = now();
    let paused = false;
    try {
      paused = opts.paused();
    } catch {
      paused = false;
    }
    if (!paused) elapsed += t - last;
    last = t;
    if (!done && elapsed >= windowMs && elapsed < maxMs) {
      let advanced = false;
      try { advanced = opts.progress?.() ?? false; } catch { /* a broken progress probe cannot grant more time */ }
      if (advanced) windowMs = Math.min(maxMs, windowMs + opts.limitMs);
    }
    opts.onTick?.(elapsed, windowMs);
    if (!done && elapsed >= windowMs) {
      done = true;
      clearInterval(timer);
      opts.onExpire();
    }
  };
  const timer = setInterval(check, tickMs);
  timer.unref?.();
  return {
    stop: () => {
      done = true;
      clearInterval(timer);
    },
    elapsed: () => elapsed,
    window: () => windowMs,
  };
}
