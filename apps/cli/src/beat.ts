import * as fs from 'node:fs';
import * as path from 'node:path';
import { beatTrap, loadConfig, lobstahHome } from '@lobstah/core';
import type { BeatResult } from '@lobstah/core';
import { readHookStdin } from './soak-site.js';

/** The post-tool hook's stdin: Claude Code and Codex share these fields. */
export interface PostToolHookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
}

/** Errors go here, never to the tool call. */
function logError(err: unknown): void {
  try {
    const dir = path.join(lobstahHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const msg = err instanceof Error ? err.message : String(err);
    fs.appendFileSync(path.join(dir, 'beat.log'), `${new Date().toISOString()} ${msg.replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch {
    // nowhere left to say it
  }
}

/**
 * `lobstah soak beat`: the post-tool hook. Refreshes the trap's liveness and
 * writes its catch's activity. It never fails the tool call: every path
 * returns normally and prints nothing, and errors go to logs/beat.log.
 */
export function runBeat(input: PostToolHookInput | undefined = readHookStdin() as PostToolHookInput | undefined): BeatResult | undefined {
  try {
    if (!loadConfig().soak.beat) return undefined;
    return beatTrap({
      cwd: input?.cwd ?? process.cwd(),
      sessionId: input?.session_id,
      toolName: input?.tool_name,
      toolInput: input?.tool_input,
    });
  } catch (err) {
    logError(err);
    return undefined;
  }
}
