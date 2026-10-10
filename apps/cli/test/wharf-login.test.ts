import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { saveWharfCredential, wharfCredential, wharfFor, agentEnvironment, loadConfig } from '@lobstah/core';
import type { BackendScope } from '@lobstah/core';
import { wharfLogin, cleanBoatName, systemBoatName } from '../src/wharf-login.js';
import childProcess from 'node:child_process';
import { wharfCommand } from '../src/wharf-commands.js';
import { parseArgs } from '../src/usage.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const token = 'b.person.laptop.0123456789abcdef0123456789abcdef';
const scope: Extract<BackendScope, { kind: 'wharf' }> = { kind: 'wharf', wharf: 'cloud', grounds: 'away', repos: [],
  location: { kind: 'wharf', url: 'https://state.test', account: 'person', tokenEnv: 'LOBSTAH_TEST_LOGIN_TOKEN' } };
const opts = (flags: Record<string, string> = {}) => ({ opt: (flag: string) => flags[flag], has: (flag: string) => flag in flags, values: () => [] });
const code = { device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://glass.test/device', expires_in: 300, interval: 1 };
const issued = (credential = token) => ({ token: credential, id: 'laptop', name: 'laptop', permissions: ['work', 'read'] });
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-login-'));
  vi.stubEnv('LOBSTAH_HOME', home); vi.stubEnv('LOBSTAH_TEST_LOGIN_TOKEN', ''); vi.stubEnv('LOBSTAH_WHARF_AGENT', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); removeTempDir(home); });

it('uses a deterministic cleaned short system name, removing possessives and punctuation with bounded ASCII output', () => {
  expect(cleanBoatName("Chris’s MacBook Pro! (Work)")).toBe('chris-macbook-pro-work');
  expect(cleanBoatName("Chris's boat_name.test")).toBe('chris-boatnametest');
  expect(cleanBoatName('!✨')).toBe('boat');
  expect(cleanBoatName('a'.repeat(100))).toHaveLength(64);
  vi.spyOn(os, 'hostname').mockReturnValue('ChriS-Desktop.local');
  const system = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('Short-Mac\n');
  expect(systemBoatName()).toBe(process.platform === 'darwin' ? 'short-mac' : 'chris-desktop');
  system.mockImplementation(() => { throw new Error('not available'); });
  expect(systemBoatName()).toBe('chris-desktop');
});

it('re-login keeps the existing name without --name even if the system name changed', async () => {
  saveWharfCredential(scope, token);
  const transport = vi.fn().mockResolvedValueOnce(Response.json({ name: 'already-named' })).mockResolvedValueOnce(Response.json(code)).mockResolvedValueOnce(Response.json(issued()));
  vi.stubGlobal('fetch', transport); vi.spyOn(console, 'log').mockImplementation(() => {});
  await wharfLogin(scope, 'login', opts());
  expect(JSON.parse(transport.mock.calls[1][1].body)).toMatchObject({ name: 'already-named', boatToken: token });
});

it.each([['read', {}], ['helm', { '--helm': '' }], ['none', { '--work-only': '' }]] as const)('login requests %s, stores only a boat and does not print secrets', async (steering, flags) => {
  const transport = vi.fn().mockResolvedValueOnce(Response.json(code)).mockResolvedValueOnce(Response.json(issued()));
  vi.stubGlobal('fetch', transport); const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await wharfLogin(scope, 'login', opts({ '--name': 'laptop', ...flags }));
  expect(transport.mock.calls[0][0]).toBe('https://state.test/v1/auth/device/code');
  expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ client_id: 'lobstah-cli', account: 'person', name: 'laptop', steering });
  expect(transport.mock.calls.every(([, init]) => !init.headers.Authorization && init.redirect === 'manual')).toBe(true);
  expect(wharfCredential(scope)).toBe(token);
  expect(JSON.stringify(output.mock.calls)).not.toContain(token); expect(JSON.stringify(output.mock.calls)).not.toContain(code.device_code);
  const file = path.join(home, 'credentials', 'wharf-cloud.json');
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ url: scope.location.url, account: 'person', token });
});

it('uses stored credentials for commands; re-login proves the current boat and logout removes only the local credential', async () => {
  saveWharfCredential(scope, token);
  const next = 'b.person.laptop.abcdefabcdefabcdefabcdefabcdefab';
  const transport = vi.fn().mockResolvedValueOnce(Response.json({ name: 'laptop' })).mockResolvedValueOnce(Response.json(code)).mockResolvedValueOnce(Response.json(issued(next)));
  vi.stubGlobal('fetch', transport); vi.spyOn(console, 'log').mockImplementation(() => {});
  await wharfLogin(scope, 'login', opts({ '--name': 'desk', '--helm': '' }));
  expect(transport.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  expect(JSON.parse(transport.mock.calls[1][1].body)).toMatchObject({ name: 'desk', steering: 'helm', boatToken: token });
  expect(wharfCredential(scope)).toBe(next);
  transport.mockResolvedValueOnce(Response.json({ name: 'desk' })); await wharfFor(scope).request('_boat');
  expect(transport.mock.calls.at(-1)?.[1].headers.Authorization).toBe(`Bearer ${next}`);
  const calls = transport.mock.calls.length; await wharfLogin(scope, 'logout', opts());
  expect(wharfCredential(scope)).toBe(''); expect(transport).toHaveBeenCalledTimes(calls);
});

it('rejects person/job credentials and imports an existing boat via file, not a process argument', async () => {
  const file = path.join(home, 'input'); fs.writeFileSync(file, 'person-session');
  vi.spyOn(console, 'log').mockImplementation(() => {}); const transport = vi.fn(); vi.stubGlobal('fetch', transport);
  await expect(wharfLogin(scope, 'login', opts({ '--credential-file': file }))).rejects.toThrow('boat token only');
  expect(transport).not.toHaveBeenCalled(); expect(wharfCredential(scope)).toBe('');
  fs.writeFileSync(file, 'x'.repeat(4097));
  await expect(wharfLogin(scope, 'login', opts({ '--credential-file': file }))).rejects.toThrow('exceeds 4 KiB');
  transport.mockResolvedValueOnce(Response.json({ name: 'laptop', permissions: ['work'] })); fs.writeFileSync(file, `${token}\n`);
  await wharfLogin(scope, 'login', opts({ '--credential-file': file })); expect(wharfCredential(scope)).toBe(token);
  expect(() => saveWharfCredential(scope, 'd.person.job.1.secret')).toThrow('not a person or job token');
  const changed = { ...scope, location: { ...scope.location, account: 'someone-else' } };
  expect(() => wharfCredential(changed)).toThrow('saved boat credential is invalid');
});

it('a timed-out or refused approval saves nothing and pending polling honors its interval', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {});
  const transport = vi.fn().mockResolvedValueOnce(Response.json({ ...code, expires_in: 1 })).mockImplementation(async () => Response.json({ error: 'authorization_pending' }, { status: 400 }));
  vi.stubGlobal('fetch', transport);
  const pending = expect(wharfLogin(scope, 'login', opts({ '--name': 'laptop' }))).rejects.toThrow('timed out');
  await vi.runAllTimersAsync(); await pending;
  expect(transport).toHaveBeenCalledTimes(2); expect(wharfCredential(scope)).toBe('');
  transport.mockReset().mockResolvedValueOnce(Response.json(code)).mockResolvedValueOnce(Response.json({ error: 'access_denied' }, { status: 400 }));
  await expect(wharfLogin(scope, 'login', opts({ '--name': 'laptop' }))).rejects.toThrow('refused'); expect(wharfCredential(scope)).toBe('');
});

it('job subprocesses get only their dispatch token, never fall back to stored boats, and cannot log in', async () => {
  saveWharfCredential(scope, token);
  const config = loadConfig(); config.wharves = { cloud: scope.location };
  const job = 'd.person.job.1.secret'; const env = agentEnvironment(config, scope, job, {});
  expect(env.LOBSTAH_WHARF_AGENT).toBe('1'); expect(env.LOBSTAH_TEST_LOGIN_TOKEN).toBe(job);
  vi.stubEnv('LOBSTAH_WHARF_AGENT', '1'); expect(wharfCredential(scope)).toBe('');
  await expect(wharfLogin(scope, 'login', opts())).rejects.toThrow('job subprocesses');
  vi.stubEnv('LOBSTAH_TEST_LOGIN_TOKEN', job); expect(wharfCredential(scope)).toBe(job);
});

it('login routes before credential construction and rejects extra/admin flags', async () => {
  const config = loadConfig(); config.wharves = { cloud: scope.location }; config.grounds = { away: { wharf: 'cloud', repos: [] } };
  const transport = vi.fn().mockResolvedValueOnce(Response.json(code)).mockResolvedValueOnce(Response.json(issued()));
  vi.stubGlobal('fetch', transport); vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(wharfCommand('wharf', ['login'], opts({ '--grounds': 'away', '--name': 'laptop' }), config)).resolves.toBe(true);
  expect(parseArgs('wharf', ['login', '--admin'])?.error).toContain('unknown flag');
  await expect(wharfLogin(scope, 'login', opts({ '--helm': '', '--work-only': '' }))).rejects.toThrow('not both');
});
