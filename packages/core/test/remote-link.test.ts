import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { claudeTranscriptFile, transcriptRemoteLink, validRemoteLink } from '../src/remote-link.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const URL_A = 'https://claude.ai/code/session_01AbC';
const URL_B = 'https://claude.ai/code/session_02DeF?bridge=env_1';
const START = Date.parse('2026-11-03T12:00:00.000Z');
const at = (secs: number) => new Date(START + secs * 1000).toISOString();
/** The message Claude Code 2.1.317 builds for a connected session, as a transcript line. */
const status = (url: unknown, timestamp: string) =>
  JSON.stringify({ type: 'system', subtype: 'bridge_status', content: `/remote-control is active · Continue here, on your phone, or at ${String(url)}`, url, isMeta: false, timestamp, uuid: 'u', sessionId: 'local-id' }) + '\n';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-remote-link-'));
  file = path.join(dir, 'session.jsonl');
});
afterEach(() => removeTempDir(dir));

it('accepts only the https Claude session URL', () => {
  expect(validRemoteLink(URL_A)).toBe(true);
  expect(validRemoteLink(URL_B)).toBe(true);
  for (const bad of ['http://claude.ai/code/a', 'https://claude.ai.evil.test/code/a', 'https://evil.test/https://claude.ai/code/a', 'claude://claude.ai/code/a', 'codex://threads/a', 'https://claude.ai/code/', 'https://claude.ai/code/a/b', `${URL_A}\n`, `${URL_A} x`, `https://claude.ai/code/${'a'.repeat(600)}`, 1, undefined]) {
    expect(validRemoteLink(bad), String(bad)).toBe(false);
  }
});

it('reads the URL Claude wrote, and the newest one wins', () => {
  fs.writeFileSync(file, '{"type":"user"}\n' + status(URL_A, at(5)));
  expect(transcriptRemoteLink(file, START)).toBe(URL_A);
  fs.appendFileSync(file, status(URL_B, at(9)));
  expect(transcriptRemoteLink(file, START)).toBe(URL_B);
});

it("ignores a URL from before this run: a resumed transcript's old link may not connect", () => {
  fs.writeFileSync(file, status(URL_A, at(-60)));
  expect(transcriptRemoteLink(file, START)).toBeUndefined();
  fs.appendFileSync(file, status(URL_B, at(1)));
  expect(transcriptRemoteLink(file, START)).toBe(URL_B);
});

it('finds nothing without a real status line, and never builds a URL', () => {
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: 'bridge_status https://claude.ai/code/typed-by-someone', url: URL_A, timestamp: at(1) }),
    JSON.stringify({ type: 'system', subtype: 'cloud_session_status', url: URL_A, timestamp: at(1) }),
    status('https://evil.test/code/a', at(2)).trim(),
    status(URL_A, 'not a time').trim(),
    '{"type":"system","subtype":"bridge_status",broken',
    '',
  ].join('\n'));
  expect(transcriptRemoteLink(file, START)).toBeUndefined();
  expect(transcriptRemoteLink(path.join(dir, 'missing.jsonl'), START)).toBeUndefined();
});

it('waits for a line still being written, across chunks and multi-byte text', () => {
  const line = status(URL_A, at(1));
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', text: '→'.repeat(700_000) })}\n${line.slice(0, 40)}`);
  expect(transcriptRemoteLink(file, START)).toBeUndefined();
  fs.appendFileSync(file, line.slice(40));
  expect(transcriptRemoteLink(file, START)).toBe(URL_A);
});

it('starts over when a transcript shrinks', () => {
  fs.writeFileSync(file, '{"type":"user","text":"long enough to outgrow the rewrite below, by some margin, for certain, yes indeed, and then a good deal more besides that, truly a very long line"}\n' + status(URL_A, at(1)));
  expect(transcriptRemoteLink(file, START)).toBe(URL_A);
  fs.writeFileSync(file, status(URL_B, at(0)));
  expect(transcriptRemoteLink(file, START)).toBe(URL_B);
});

it('finds a session under the directory it started in, or anywhere in the Claude home', () => {
  const home = path.join(dir, 'claude');
  const here = path.join(home, 'projects', '-tmp-repo');
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, 'abc.jsonl'), '');
  expect(claudeTranscriptFile('abc', ['/tmp/repo'], home)).toBe(path.join(here, 'abc.jsonl'));
  expect(claudeTranscriptFile('abc', ['/tmp/worktree'], home)).toBe(path.join(here, 'abc.jsonl'));
  expect(claudeTranscriptFile('other', ['/tmp/repo'], home)).toBeUndefined();
  expect(claudeTranscriptFile('abc', [], path.join(dir, 'no-home'))).toBeUndefined();
});
