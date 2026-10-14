import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, uniqueTempPath } from './paths.js';
import type { BackendScope } from './backend-scope.js';

type WharfScope = Extract<BackendScope, { kind: 'wharf' }>;
function credentialPath(scope: WharfScope): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scope.wharf)) throw new Error('invalid wharf name');
  return path.join(lobstahHome(), 'credentials', `wharf-${scope.wharf}.json`);
}
export function isBoatCredential(token: unknown, account: string): token is string {
  return typeof token === 'string' && token.length <= 1024 && token.startsWith(`b.${account}.`) && /^b\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,512}$/.test(token);
}
/** Explicit environment capabilities win; a stored boat never replaces a job token. */
export function wharfCredential(scope: WharfScope): string {
  if (process.env[scope.location.tokenEnv]) return process.env[scope.location.tokenEnv]!;
  if (process.env.LOBSTAH_WHARF_AGENT === '1') return ''; // Never hand stored boats to a job subprocess.
  try {
    const file = credentialPath(scope);
    if (fs.statSync(file).size > 4096) throw new Error('invalid credential file');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.url !== scope.location.url || saved.account !== scope.location.account || !isBoatCredential(saved.token, scope.location.account)) throw new Error('saved credential does not match this wharf');
    return saved.token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error('saved boat credential is invalid; use wharf login again');
  }
}
/** Persist only the boat capability, never a browser/person or provider session. */
export function saveWharfCredential(scope: WharfScope, token: unknown): void {
  if (!isBoatCredential(token, scope.location.account)) throw new Error('login must return this wharf account’s boat credential, not a person or job token');
  const file = credentialPath(scope), tmp = uniqueTempPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, JSON.stringify({ url: scope.location.url, account: scope.location.account, token }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function forgetWharfCredential(scope: WharfScope): void {
  fs.rmSync(credentialPath(scope), { force: true });
}
