import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/** Whether an executable with this name is reachable on the current PATH. */
export function onPath(bin: string, pathVar: string | undefined = process.env.PATH): boolean {
  if (!pathVar) return false;
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

function resolvable(specifier: string): boolean {
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * The harnesses this host can actually run: claude via its CLI or the agent
 * SDK, codex via its CLI or the SDK's vendored binary. The daemon heartbeat
 * reports this instead of a hardcoded claim.
 */
export function detectHarnesses(): string[] {
  const out: string[] = [];
  if (onPath('claude') || resolvable('@anthropic-ai/claude-agent-sdk')) out.push('claude');
  if (onPath('codex') || resolvable('@openai/codex-sdk')) out.push('codex');
  return out;
}

/**
 * A way to invoke the codex CLI even when `codex` is not on PATH: the codex
 * SDK dependency vendors the full CLI, so an installed lobstah can run it as
 * `node <resolved bin/codex.js>`. Returns undefined when neither exists.
 */
export function codexInvocation(argv: string[]): { file: string; argv: string[] } | undefined {
  if (onPath('codex')) return { file: 'codex', argv };
  try {
    const cli = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    return { file: process.execPath, argv: [cli, ...argv] };
  } catch {
    return undefined;
  }
}
