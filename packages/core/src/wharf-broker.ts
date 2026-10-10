import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lobstahHome, uniqueTempPath } from './paths.js';
import type { BackendMessage, ClaimReceipt } from './backend-model.js';

export interface BrokerAddress { pid: number; port: number; nonce: string }
export interface BrokerAgent {
  grounds: string; repo: string; trap: string; session: string; capability: string; worktree: string; origin?: string;
}
export const brokerAddressFile = () => path.join(lobstahHome(), 'wharf-broker.json');
function agentFile(grounds: string, cwd: string) {
  const key = createHash('sha256').update(`${grounds}:${path.resolve(cwd)}`).digest('hex');
  return path.join(lobstahHome(), 'wharf-traps', `${key}.json`);
}
export function readBrokerAgent(grounds: string, cwd = process.cwd()): BrokerAgent | undefined {
  try {
    const a = JSON.parse(fs.readFileSync(agentFile(grounds, cwd), 'utf8')) as BrokerAgent;
    return a.grounds === grounds && typeof a.capability === 'string' && typeof a.session === 'string' ? a : undefined;
  } catch { return undefined; }
}
export function saveBrokerAgent(a: BrokerAgent, cwd = process.cwd()): void {
  const file = agentFile(a.grounds, cwd), tmp = uniqueTempPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function forgetBrokerAgent(grounds: string, cwd = process.cwd()): void { fs.rmSync(agentFile(grounds, cwd), { force: true }); }
/** A local interface carries only tickets/session capabilities and job tokens, never boat credentials. */
export async function brokerRequest<T = unknown>(route: string, body: unknown): Promise<T> {
  let address: BrokerAddress;
  try {
    address = JSON.parse(fs.readFileSync(brokerAddressFile(), 'utf8'));
    if (!Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65535 || !/^[a-f0-9]{64}$/.test(address.nonce)) throw new Error();
    process.kill(address.pid, 0);
  } catch { throw new Error("the boat's daemon is not running; start it before soaking on wharf grounds"); }
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${address.port}/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lobstah-Broker': address.nonce }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch { throw new Error("the boat's daemon is not running or reachable; no credential fallback"); }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'boat broker refused request');
  return value as T;
}
export interface BrokerPoll { claim: ClaimReceipt | null; dispatch?: string; messages?: BackendMessage[] }
