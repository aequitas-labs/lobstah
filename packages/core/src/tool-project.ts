import fs from 'node:fs';
import path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';

/**
 * The project a tool's own calls in a trap session name inline, such as
 * `UME_PROJECT=vr95mce908 ume await …`. A wait another tool registers with
 * the trap's turn end (docs/turn-end.md) runs in the daemon, where that
 * inline setting is missing: the daemon runs it with the session's recorded
 * `<TOOL>_PROJECT`, so the wait reads the same project the trap does.
 */

/** A tool's name as a turn-wait registration's `from` gives it, such as `ume`. */
export type ToolName = string;

/** One inline project setting: the variable, its value, and when the trap last used it. */
export interface ToolProject {
  /** `<TOOL>_PROJECT`, such as `UME_PROJECT`. */
  variable: string;
  value: string;
  at: string;
}

/** The project each tool's calls in one session last named, by tool. */
type SessionToolProjects = Record<ToolName, ToolProject>;

/** A project id: no spaces, quotes or shell syntax. */
const PROJECT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * `<TOOL>_PROJECT=<value>` set inline before a call of that tool (or of
 * `<tool>-<variant>`, such as `ume-next`), with any other settings between.
 */
const INLINE_PROJECT = /(?:^|[\s;&|(`'"])([A-Z][A-Z0-9]*)_PROJECT=(\S+)\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([a-z][a-z0-9]*)(?:-[a-z0-9]+)?(?=$|[\s;&|)'"])/g;

/** The tool projects a shell command sets inline, in order. */
export function toolProjectsInCommand(command: string): { tool: ToolName; variable: string; value: string }[] {
  const found: { tool: ToolName; variable: string; value: string }[] = [];
  for (const m of command.matchAll(INLINE_PROJECT)) {
    const prefix = m[1]!;
    const value = m[2]!.replace(/^['"]|['"]$/g, '');
    if (m[3] !== prefix.toLowerCase() || !PROJECT_VALUE.test(value)) continue;
    found.push({ tool: m[3]!, variable: `${prefix}_PROJECT`, value });
  }
  return found;
}

/** A shell tool call's command text, for Claude Code's `{ command: string }` and Codex's `{ command: string[] }`. */
export function shellCommandText(toolInput: unknown): string | undefined {
  const command = (toolInput as { command?: unknown } | undefined)?.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return undefined;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const projectsFile = (sessionId: string): string => path.join(lobstahHome(), 'tool-projects', `${sessionId}.json`);

function readSessionProjects(sessionId: string): SessionToolProjects {
  try { return JSON.parse(fs.readFileSync(projectsFile(sessionId), 'utf8')) as SessionToolProjects; } catch { return {}; }
}

/** Record the tool projects a trap session's command sets inline. Writes nothing for a command that sets none. */
export function recordToolProjects(sessionId: string, command: string, now: number = Date.now()): void {
  if (!SESSION_ID.test(sessionId)) return;
  const found = toolProjectsInCommand(command);
  if (found.length === 0) return;
  const projects = readSessionProjects(sessionId);
  const at = new Date(now).toISOString();
  for (const f of found) projects[f.tool] = { variable: f.variable, value: f.value, at };
  const file = projectsFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(projects));
  atomicRenameSync(tmp, file);
}

/** The environment a session's wait from `tool` runs with: its recorded project, or nothing. */
export function toolProjectEnv(sessionId: string, tool: ToolName): Record<string, string> {
  if (!SESSION_ID.test(sessionId)) return {};
  const project = readSessionProjects(sessionId)[tool];
  return project && PROJECT_VALUE.test(project.value) ? { [project.variable]: project.value } : {};
}
