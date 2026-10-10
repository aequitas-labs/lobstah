import * as fs from 'node:fs';
import os from 'node:os';
import childProcess from 'node:child_process';
import { forgetWharfCredential, isBoatCredential, saveWharfCredential, wharfCredential, WharfBackend } from '@lobstah/core';
import type { BackendScope } from '@lobstah/core';

type Options = { opt: (flag: string) => string | undefined; has: (flag: string) => boolean };
type WharfScope = Extract<BackendScope, { kind: 'wharf' }>;
export function cleanBoatName(value: string): string {
  return value.toLowerCase().replace(/['’]s\b/g, '').replace(/['’]/g, '').replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/[\s-]+/g, '-').slice(0, 64).replace(/-+$/, '') || 'boat';
}
export function systemBoatName(): string {
  if (process.platform === 'darwin') {
    try {
      const short = childProcess.execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (short) return cleanBoatName(short);
    } catch { /* A missing short system name falls back to the hostname. */ }
  }
  return cleanBoatName(os.hostname().split('.')[0]);
}
function importedCredential(file: string): string {
  const descriptor = file === '-' ? 0 : fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4097); let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > 4096) throw new Error('credential file exceeds 4 KiB');
    return bytes.subarray(0, length).toString('utf8').trim();
  } finally { if (file !== '-') fs.closeSync(descriptor); }
}
async function authPost(scope: WharfScope, path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${scope.location.url}/v1/auth/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const reader = response.body?.getReader(); let text = '', bytes = 0;
  if (!reader) throw new Error('empty wharf login response');
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      if ((bytes += part.value.length) > 65536) throw new Error('wharf login response too large');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  let data: unknown; try { data = JSON.parse(text); } catch { throw new Error('invalid wharf login response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || response.status >= 300 && response.status < 400) throw new Error('invalid wharf login response');
  return { status: response.status, data: data as Record<string, unknown> };
}
export async function wharfLogin(scope: WharfScope, action: string, opts: Options): Promise<void> {
  if (process.env.LOBSTAH_WHARF_AGENT === '1') throw new Error('job subprocesses cannot enroll or store boat credentials');
  if (action === 'logout') {
    forgetWharfCredential(scope);
    console.log('Boat credential removed from this wharf’s local store. Revoke it in the signed-in glass to invalidate it elsewhere.');
    if (process.env[scope.location.tokenEnv]) console.log(`A credential is still set in ${scope.location.tokenEnv}; unset it separately.`);
    return;
  }
  if (opts.has('--helm') && opts.has('--work-only')) throw new Error('choose --helm or --work-only, not both');
  const credentialFile = opts.opt('--credential-file');
  if (credentialFile) {
    if (opts.opt('--name') || opts.has('--helm') || opts.has('--work-only')) throw new Error('credential import does not change boat name or access');
    const token = importedCredential(credentialFile);
    if (!isBoatCredential(token, scope.location.account)) throw new Error('credential file must contain this account’s boat token only');
    const boat = await new WharfBackend(scope.location, token).request('_boat');
    saveWharfCredential(scope, token); console.log(JSON.stringify({ loggedIn: true, boat })); return;
  }
  const old = wharfCredential(scope);
  if (old && !isBoatCredential(old, scope.location.account)) throw new Error('login acts as a boat, not a person or dispatch credential');
  const current = old ? await new WharfBackend(scope.location, old).request('_boat') as { name: string } : undefined;
  const name = opts.opt('--name') ?? current?.name ?? systemBoatName();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('choose --name with 1–64 letters, digits, hyphens or underscores');
  const steering = opts.has('--work-only') ? 'none' : opts.has('--helm') ? 'helm' : 'read';
  const issued = await authPost(scope, 'device/code', { client_id: 'lobstah-cli', account: scope.location.account, name, steering, ...(old ? { boatToken: old } : {}) });
  if (issued.status !== 200) throw new Error('wharf could not start boat approval');
  const code = issued.data;
  if (typeof code.device_code !== 'string' || code.device_code.length > 256 || typeof code.user_code !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(code.user_code) || typeof code.verification_uri !== 'string') throw new Error('invalid boat approval code');
  const url = new URL(code.verification_uri);
  if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid boat approval URL');
  const expires = Number(code.expires_in), requested = Number(opts.opt('--timeout') ?? expires);
  if (!Number.isFinite(expires) || expires <= 0 || expires > 3600 || !Number.isFinite(requested) || requested <= 0) throw new Error('invalid boat approval timeout');
  let interval = Number(code.interval ?? 5);
  if (!Number.isFinite(interval) || interval < 1 || interval > 30) throw new Error('invalid boat approval interval');
  console.log(`Approve boat ${name} (${steering === 'none' ? 'work only' : `work + ${steering}`}) at ${url.href}, code ${code.user_code}. The browser can approve, lower access, or refuse.`);
  const deadline = Date.now() + Math.min(expires, requested) * 1000;
  while (Date.now() < deadline) {
    const result = await authPost(scope, 'device/token', { client_id: 'lobstah-cli', device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (result.status === 200) {
      saveWharfCredential(scope, result.data.token);
      if (process.env[scope.location.tokenEnv]) console.log(`Unset ${scope.location.tokenEnv} to use the saved login; environment credentials take precedence.`);
      console.log(JSON.stringify({ loggedIn: true, boat: { id: result.data.id, name: result.data.name, permissions: result.data.permissions } })); return;
    }
    if (result.data.error === 'slow_down') interval += 5;
    else if (result.data.error !== 'authorization_pending') throw new Error('boat approval refused, expired, or invalid; nothing was saved');
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval * 1000, Math.max(0, deadline - Date.now()))));
  }
  throw new Error('boat approval timed out; nothing was saved');
}
