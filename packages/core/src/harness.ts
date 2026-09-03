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

/**
 * Whether a package is installed and reachable from here. require.resolve
 * alone is not enough: an ESM-only package whose exports map carries only an
 * `import` condition (the codex SDK) throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * from a CJS resolver even though a dynamic import works fine — so fall back
 * to checking the package directory on disk along the resolution paths.
 */
export function packagePresent(specifier: string, fromFile: string = import.meta.url): boolean {
  const require_ = createRequire(fromFile);
  try {
    require_.resolve(specifier);
    return true;
  } catch {
    // export-restricted or absent — the disk decides which
  }
  for (const dir of require_.resolve.paths(specifier) ?? []) {
    if (fs.existsSync(path.join(dir, specifier, 'package.json'))) return true;
  }
  return false;
}

/**
 * The harnesses this host can actually run: claude via its CLI or the agent
 * SDK, codex via its CLI or the SDK's vendored binary. The daemon heartbeat
 * reports this instead of a hardcoded claim.
 */
export function detectHarnesses(): string[] {
  const out: string[] = [];
  if (onPath('claude') || packagePresent('@anthropic-ai/claude-agent-sdk')) out.push('claude');
  if (onPath('codex') || packagePresent('@openai/codex-sdk')) out.push('codex');
  return out;
}

/**
 * A way to invoke the codex CLI even when `codex` is not on PATH: the codex
 * SDK dependency vendors the full CLI, so an installed lobstah can run it as
 * `node <resolved bin/codex.js>`. Returns undefined when neither exists.
 */
export function codexInvocation(argv: string[]): { file: string; argv: string[] } | undefined {
  if (onPath('codex')) return { file: 'codex', argv };
  const require_ = createRequire(import.meta.url);
  try {
    const cli = require_.resolve('@openai/codex/bin/codex.js');
    return { file: process.execPath, argv: [cli, ...argv] };
  } catch {
    // exports-restricted resolution — take the disk route
  }
  for (const dir of require_.resolve.paths('@openai/codex') ?? []) {
    const cli = path.join(dir, '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(cli)) return { file: process.execPath, argv: [cli, ...argv] };
  }
  return undefined;
}
