import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexInvocation } from '@lobstah/core';

/** How long a one-shot `hooks/list` may take before lobstah falls back to its own hash. */
const HOOK_LIST_TIMEOUT_MS = 15_000;

/** One hook as Codex reports it from `hooks/list`. */
export interface CodexListedHook {
  /** The `[hooks.state]` key Codex trusts it under. */
  key: string;
  command?: string;
  /** `sha256:<hook>`, or from Codex 0.166 for a plugin hook, `sha256:<hook>/sha256:<plugin contents>`. */
  currentHash: string;
  /** `trusted`, `modified` or `untrusted`. */
  trustStatus: string;
}

/** What Codex reports for a checkout, by `[hooks.state]` key. */
export type CodexHookList = ReadonlyMap<string, CodexListedHook>;

/** The values a `[hooks.state]` entry needs for Codex to treat a hook as trusted. */
export interface CodexHookTrustValues {
  trusted_hash: string;
  /** Codex 0.166 and later, plugin hooks only. */
  trusted_content_hash?: string;
}

/** Split Codex's `currentHash` into the fields it stores as trust. */
export function codexHookTrustValues(currentHash: string): CodexHookTrustValues {
  const [hookHash, contentHash] = currentHash.split('/');
  return { trusted_hash: hookHash!, ...(contentHash ? { trusted_content_hash: contentHash } : {}) };
}

/** A `[hooks.state]` entry as one inline TOML table. */
export function codexHookTrustToml(values: CodexHookTrustValues): string {
  const fields = Object.entries(values).map(([field, value]) => `${field}=${JSON.stringify(value)}`);
  return `{${fields.join(',')}}`;
}

/** The hook list in one `hooks/list` reply; undefined when it has an unexpected shape. */
function hookListFromReply(reply: { result?: { data?: Array<{ hooks?: unknown }> } }): CodexHookList | undefined {
  const hooks = reply.result?.data?.[0]?.hooks;
  if (!Array.isArray(hooks)) return undefined;
  const listed = hooks.filter((hook): hook is CodexListedHook => typeof hook?.key === 'string' && typeof hook?.currentHash === 'string');
  return new Map(listed.map((hook) => [hook.key, hook]));
}

/**
 * Ask Codex for its own view of a checkout's hooks, through a short-lived
 * `codex app-server`. Codex owns the hash: since 0.166 a plugin hook's hash
 * also covers the plugin's contents, which lobstah can't reproduce. Read-only,
 * and never rejects: a missing or older Codex resolves to undefined.
 *
 * The server exits when its stdin closes, even with a request in hand, so
 * stdin stays open until the reply arrives.
 */
export function listCodexHooks(cwd: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CodexHookList | undefined> {
  const invocation = codexInvocation(['app-server', '--listen', 'stdio://']);
  if (!invocation) return Promise.resolve(undefined);
  const listRequestId = 2;
  const requests = [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'lobstah', title: 'lobstah', version: '0' }, capabilities: { experimentalApi: true } } },
    { method: 'initialized' },
    { id: listRequestId, method: 'hooks/list', params: { cwds: [cwd] } },
  ];
  return new Promise((resolve) => {
    const server = spawn(invocation.file, invocation.argv, { cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (list: CodexHookList | undefined): void => {
      clearTimeout(timer);
      server.kill();
      resolve(list);
    };
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs ?? HOOK_LIST_TIMEOUT_MS);
    server.on('error', () => finish(undefined));
    server.on('exit', () => finish(undefined));
    server.stdin.on('error', () => finish(undefined));
    createInterface({ input: server.stdout }).on('line', (line) => {
      try {
        const reply = JSON.parse(line) as { id?: unknown; result?: { data?: Array<{ hooks?: unknown }> } };
        if (reply.id === listRequestId) finish(hookListFromReply(reply));
      } catch {
        // Not a protocol line.
      }
    });
    server.stdin.write(requests.map((request) => `${JSON.stringify(request)}\n`).join(''));
  });
}
