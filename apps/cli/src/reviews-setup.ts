import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { configPath, DEFAULT_ATTENTION_KINDS, loadConfig, REVIEW_MODES, uniqueTempPath, withDirLock } from '@lobstah/core';
import { loadPickupConfig, pickupPlan } from '@lobstah/pick';
import { installService } from './service.js';

/** Change only the reviews keys and attention list, retaining comments and unrelated tables. */
export function writeReviewMode(mode: string, identity?: string): void {
  if (!(REVIEW_MODES as readonly string[]).includes(mode)) throw new Error('reviews mode must be notify, on-demand, or auto');
  if (identity !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(identity)) throw new Error('invalid GitHub login');
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withDirLock(
    `${file}.lock`,
    () => {
      let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const raw = parse(text) as Record<string, unknown>;
      const reviews = (raw.reviews ?? {}) as Record<string, unknown>;
      const keys: Record<string, unknown> = { enabled: true, mode, ...(identity ? { identity } : {}) };
      if (
        !reviews.tokenCommand &&
        !reviews.tokenEnv &&
        !reviews.tokenFile &&
        (identity !== undefined || !(raw.pickup as { github?: unknown } | undefined)?.github)
      )
        keys.tokenCommand = 'gh auth token';
      if (reviews.repos === undefined && identity !== undefined) keys.repos = 'any';
      const head = /^\s*\[reviews\]\s*(?:#.*)?$/m.exec(text);
      if (!head && raw.reviews !== undefined) throw new Error('reviews setup needs a [reviews] table');
      if (head) {
        const start = head.index + head[0].length;
        const next = /^\s*\[/m.exec(text.slice(start));
        const end = next ? start + next.index : text.length;
        let body = text.slice(start, end);
        for (const [key, value] of Object.entries(keys)) {
          const line = `${key} = ${JSON.stringify(value)}`;
          const found = new RegExp(`^([ \\t]*)${key}\\s*=.*$`, 'm');
          body = found.test(body) ? body.replace(found, line) : `${body.trimEnd()}\n${line}\n`;
        }
        text = text.slice(0, start) + body + '\n' + text.slice(end);
      } else
        text += `\n[reviews]\n${Object.entries(keys)
          .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
          .join('\n')}\n`;
      if (identity !== undefined) {
        const kinds = Array.isArray(raw.attentionKinds) ? raw.attentionKinds.map(String) : [...DEFAULT_ATTENTION_KINDS];
        if (!kinds.includes('review')) kinds.push('review');
        const attention = `attentionKinds = ${JSON.stringify(kinds)}`;
        text =
          raw.attentionKinds !== undefined
            ? text.replace(/^[ \t]*attentionKinds[ \t]*=[ \t]*\[[\s\S]*?\]/m, attention)
            : `${attention}\n${text}`;
      }
      parse(text);
      const temp = uniqueTempPath(file);
      fs.writeFileSync(temp, text);
      fs.renameSync(temp, file);
    },
    { staleMs: 5000, waitMs: 1000, pauseMs: 20, busy: () => new Error('config is busy; try again') },
  );
}

export async function setupReviews(
  identity?: string,
  io: { login?: () => string; install?: () => unknown; log?: (text: string) => void } = {},
): Promise<void> {
  const log = io.log ?? console.log;
  const login =
    identity ??
    loadConfig().reviews.identity ??
    io.login?.() ??
    (() => {
      const result = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0 || !result.stdout?.trim()) throw new Error('sign in with gh auth login, or pass --identity <login>');
      return result.stdout.trim();
    })();
  writeReviewMode('notify', login);
  const config = loadPickupConfig();
  for (const line of pickupPlan(config)) log(line);
  if (config.github.some((g) => g.issues || g.prFeedback || g.merge.enabled) || config.linear)
    throw new Error(
      'reviews configured in notify mode; pick was not installed because issue, PR-feedback, or merge pickup is also enabled. Disable those loops explicitly before installing reviews-only polling.',
    );
  const installed = (io.install ?? (() => installService('pick')))();
  log(JSON.stringify({ reviews: login, mode: 'notify', installed }));
}

/** Fresh heartbeat plus a live process; an installed unit alone is not running. */
export function pickRunning(now = Date.now()): boolean {
  try {
    const beat = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath()), 'pick.json'), 'utf8'));
    if (
      !Number.isInteger(beat.pid) ||
      beat.pid <= 0 ||
      !Number.isFinite(Date.parse(beat.heartbeat)) ||
      now - Date.parse(beat.heartbeat) > Math.max(90_000, Number(beat.pollSecs ?? 45) * 3000)
    )
      return false;
    process.kill(beat.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reviewSetupView() {
  const cfg = loadConfig().reviews;
  return { enabled: cfg.enabled, mode: cfg.mode, identity: cfg.identity, running: pickRunning() };
}
