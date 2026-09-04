import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeCliArgs, startClaudeCli } from '../src/claude.js';
import { codexExecArgs, startCodexCli } from '../src/codex.js';
import type { AdapterStartOpts } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-adapters-'));
  process.env.LOBSTAH_HOME = path.join(dir, 'home');
  fs.mkdirSync(process.env.LOBSTAH_HOME);
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

function opts(over: Partial<AdapterStartOpts> = {}): AdapterStartOpts {
  return { id: 'd1', cwd: dir, prompt: 'do the thing', limits: {}, env: {}, flags: [], ...over };
}

async function collect(events: AsyncIterable<{ type: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of events) out.push(e.type);
  return out;
}

describe('claudeCliArgs', () => {
  it('mirrors the SDK configuration onto CLI flags', () => {
    const args = claudeCliArgs(
      opts({ model: 'opus', limits: { maxTurns: 7 }, resumeSession: 'sess-9', flags: ['--effort', 'high'] }),
    );
    expect(args).toContain('--permission-mode');
    expect(args.join(' ')).toContain('--model opus');
    expect(args.join(' ')).toContain('--max-turns 7');
    expect(args.join(' ')).toContain('--resume sess-9 --fork-session');
    expect(args.join(' ')).toContain('--effort high');
  });
});

describe('startClaudeCli against a fake CLI', () => {
  function fakeClaude(body: string): { file: string; argvPrefix: string[] } {
    const script = path.join(dir, 'fake-claude.cjs');
    fs.writeFileSync(script, body);
    return { file: process.execPath, argvPrefix: [script] };
  }

  const wellBehaved = `
let started = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (!started) {
      started = true;
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cli-sess-1' }));
    }
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'working on it' }, { type: 'tool_use', name: 'Bash' } ] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [ { type: 'tool_result' } ] } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01 }));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

  it('normalizes a two-turn conversation and captures the session', async () => {
    const run = startClaudeCli(fakeClaude(wellBehaved), opts());
    const types: string[] = [];
    let sent = false;
    const reading = (async () => {
      for await (const e of run.events) {
        types.push(e.type);
        if (e.type === 'turn-end' && !sent) {
          sent = true;
          run.send('and one more thing');
          run.end();
        }
      }
    })();
    const result = await run.done;
    await reading;
    expect(result).toEqual({ sessionId: 'cli-sess-1' });
    expect(types.filter((t) => t === 'turn-end')).toHaveLength(2);
    expect(types).toContain('session');
    expect(types).toContain('text');
    expect(types).toContain('tool-start');
    expect(types).toContain('tool-end');
  });

  it('surfaces a nonzero exit with the stderr tail', async () => {
    const run = startClaudeCli(
      fakeClaude(`process.stderr.write('auth expired\\n'); process.exit(3);`),
      opts(),
    );
    run.end();
    const result = await run.done;
    await collect(run.events);
    expect(result.error).toMatch(/exited 3/);
    expect(result.error).toMatch(/auth expired/);
  });
});

describe('codexExecArgs', () => {
  it('builds a first turn and a resume turn', () => {
    const first = codexExecArgs(opts({ model: 'gpt-5-codex', effort: 'high' }), 'go');
    expect(first.slice(0, 2)).toEqual(['exec', '--json']);
    expect(first.join(' ')).toContain('--sandbox workspace-write');
    expect(first.join(' ')).toContain('-m gpt-5-codex');
    expect(first.at(-1)).toBe('go');
    const resumed = codexExecArgs(opts(), 'more', 't-42');
    expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', 't-42']);
  });
});

describe('startCodexCli against a fake CLI', () => {
  it('runs one process per turn and resumes the thread between turns', async () => {
    const argvLog = path.join(dir, 'argv.jsonl');
    const script = path.join(dir, 'fake-codex.cjs');
    fs.writeFileSync(
      script,
      `
require('fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 't-42' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done bit' } }));
`,
    );
    const run = startCodexCli((argv) => ({ file: process.execPath, argv: [script, ...argv] }), opts());
    const types: string[] = [];
    let sent = false;
    const reading = (async () => {
      for await (const e of run.events) {
        types.push(e.type);
        if (e.type === 'turn-end' && !sent) {
          sent = true;
          run.send('second turn');
          run.end();
        }
      }
    })();
    const result = await run.done;
    await reading;
    expect(result).toEqual({ sessionId: 't-42' });
    expect(types.filter((t) => t === 'turn-end')).toHaveLength(2);
    const argvs = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]!.slice(0, 2)).toEqual(['exec', '--json']);
    expect(argvs[1]!.slice(0, 3)).toEqual(['exec', 'resume', 't-42']);
  });

  it('a turn.failed event ends the run with that error', async () => {
    const script = path.join(dir, 'fake-codex-fail.cjs');
    fs.writeFileSync(
      script,
      `console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exhausted' } }));`,
    );
    const run = startCodexCli((argv) => ({ file: process.execPath, argv: [script, ...argv] }), opts());
    const result = await run.done;
    await collect(run.events);
    expect(result.error).toBe('quota exhausted');
  });
});
