import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  askDecision,
  decisionDir,
  findRunProposal,
  parseRunInput,
  parseRunTimeout,
  prepareRunCard,
  proposeRunScript,
  readStoredRunScript,
  RUN_SCRIPT_MAX_BYTES,
  RunCardError,
  scriptWarnings,
  sha256Hex,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-cards-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const script = (name: string, body: string | Buffer): string => {
  const file = path.join(home, name);
  fs.writeFileSync(file, body);
  return file;
};

describe('run card inputs and limits', () => {
  it('reads NAME as secret, NAME:text as text, and refuses anything else', () => {
    expect(parseRunInput('CRON_SECRET')).toEqual({ name: 'CRON_SECRET', secret: true });
    expect(parseRunInput('BRANCH:text')).toEqual({ name: 'BRANCH', secret: false });
    expect(parseRunInput('TOKEN:secret')).toEqual({ name: 'TOKEN', secret: true });
    for (const bad of ['1ABC', 'A B', 'A:hidden', 'A:text:x', '']) expect(() => parseRunInput(bad), bad).toThrow(RunCardError);
  });

  it('reads a time limit in seconds, minutes or hours, up to an hour', () => {
    expect(parseRunTimeout('90')).toBe(90);
    expect(parseRunTimeout('90s')).toBe(90);
    expect(parseRunTimeout('5m')).toBe(300);
    expect(parseRunTimeout('1h')).toBe(3600);
    expect(() => parseRunTimeout('2h')).toThrow(/between 1s and 60m/);
    expect(() => parseRunTimeout('0')).toThrow(RunCardError);
    expect(() => parseRunTimeout('soon')).toThrow(RunCardError);
  });

  it('refuses a script over 16 KB, an empty one, non-UTF-8 bytes, a missing cwd and repeated inputs', () => {
    expect(() => prepareRunCard({ scriptFile: script('big.sh', 'a'.repeat(RUN_SCRIPT_MAX_BYTES + 1)) })).toThrow(/exceeds 16384 bytes/);
    expect(() => prepareRunCard({ scriptFile: script('empty.sh', '') })).toThrow(/empty/);
    expect(() => prepareRunCard({ scriptFile: script('bin.sh', Buffer.from([0xff, 0xfe, 0x00])) })).toThrow(/UTF-8/);
    expect(() => prepareRunCard({ scriptFile: script('ok.sh', 'true\n'), cwd: path.join(home, 'nope') })).toThrow(/not a directory/);
    expect(() => prepareRunCard({ scriptFile: script('ok.sh', 'true\n'), inputs: ['A', 'A:text'] })).toThrow(/differ/);
    expect(() => prepareRunCard({ scriptFile: script('ok.sh', 'true\n'), output: 'all' })).toThrow(/scrubbed or exit/);
  });

  it('accepts a script of exactly 16 KB and records its hash, inputs, cwd and defaults', () => {
    const body = 'a'.repeat(RUN_SCRIPT_MAX_BYTES);
    const { card, script: bytes } = prepareRunCard({ scriptFile: script('max.sh', body), inputs: ['CRON_SECRET'], cwd: home });
    expect(bytes.length).toBe(RUN_SCRIPT_MAX_BYTES);
    expect(card).toEqual({
      scriptSha256: sha256Hex(body),
      scriptBytes: RUN_SCRIPT_MAX_BYTES,
      inputs: [{ name: 'CRON_SECRET', secret: true }],
      cwd: home,
      timeoutSecs: 300,
      output: 'scrubbed',
      interpreter: '/bin/bash',
    });
  });
});

describe('a run card on the decisions store', () => {
  it('stores the script beside the card, and the stored copy hashes to the card', () => {
    const body = '#!/bin/bash\necho hi\n';
    const run = prepareRunCard({ scriptFile: script('hi.sh', body), cwd: home });
    const { meta } = askDecision({ title: 'Say hi', options: ['Decline'], askedBy: 'helm', run, maxBytes: 1024 });
    expect(meta.run?.scriptSha256).toBe(sha256Hex(body));
    expect(readStoredRunScript(decisionDir(meta.key)!)).toEqual({ text: body, sha256: sha256Hex(body) });
  });
});

describe('characters a reader could miss', () => {
  it('names bidi, zero-width, control and other non-ASCII characters by line, column and code point', () => {
    const text = 'echo ok\nrm -rf /tmp/x‮ # cod.sh\ncurl​x\tq\ncаt\r\n';
    expect(scriptWarnings(text)).toEqual([
      { line: 2, column: 14, codePoint: 'U+202E', name: 'RIGHT-TO-LEFT OVERRIDE', kind: 'bidi' },
      { line: 3, column: 5, codePoint: 'U+200B', name: 'ZERO WIDTH SPACE', kind: 'zero-width' },
      { line: 4, column: 2, codePoint: 'U+0430', name: 'NON-ASCII CHARACTER', kind: 'non-ascii' },
      { line: 4, column: 4, codePoint: 'U+000D', name: 'CONTROL CHARACTER', kind: 'control' },
    ]);
    expect(scriptWarnings('#!/bin/bash\n\techo "plain"\n')).toEqual([]);
  });
});

describe("a trap's proposal", () => {
  it('stores the script by hash under its dispatch, for the helm to post unchanged', () => {
    const body = 'echo propose\n';
    const proposal = proposeRunScript('aaaaaaaa-0000-4000-8000-000000000001', script('p.sh', body), 'wt:t1');
    expect(proposal.sha256).toBe(sha256Hex(body));
    expect(fs.readFileSync(proposal.file, 'utf8')).toBe(body);
    expect(findRunProposal('aaaaaaaa-0000-4000-8000-000000000001', proposal.sha256)).toMatchObject({ trap: 'wt:t1', file: proposal.file });
    expect(findRunProposal('aaaaaaaa-0000-4000-8000-000000000001', sha256Hex('other'))).toBeUndefined();
    expect(() => proposeRunScript('../x', script('p2.sh', body))).toThrow(RunCardError);
  });
});
