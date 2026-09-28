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
}

export function startWallClock(opts: {
  limitMs: number;
  paused: () => boolean;
  onExpire: () => void;
  tickMs?: number;
  now?: () => number;
}): WallClock {
  const now = opts.now ?? Date.now;
  const tickMs = Math.max(1, Math.min(opts.tickMs ?? 5000, opts.limitMs));
  let elapsed = 0;
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
    if (!done && elapsed >= opts.limitMs) {
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
  };
}
