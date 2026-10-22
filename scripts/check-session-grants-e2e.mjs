// Opt-in live harness check. Requires an authenticated Claude Code with available quota.
// All grants and tool effects are isolated under a fresh temporary directory;
// the MCP navigate stand-in never contacts the target site. Budget: at most $1 per run.
// A granted call executing is insufficient proof if the baseline was already allowed.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-grant-e2e-'));
console.log('fixture', dir);
const core = await import(`${root}/packages/core/dist/index.js`);
const results = [];
for (const mode of ['baseline', 'pre-hook']) {
  const test = path.join(dir, mode);
  fs.mkdirSync(test);
  process.env.LOBSTAH_HOME = path.join(test, 'home');
  core.ensureLayout();
  const session = randomUUID();
  const log = path.join(test, 'calls.jsonl');
  if (mode !== 'baseline')
    core.addGrant({
      mode: 'session',
      session,
      tools: 'mcp__grant_fixture__*',
      hosts: ['example.com'],
      by: 'isolated-test-fixture',
      reason: 'Harmless hook end-to-end check',
    });
  const hookScript = path.join(test, 'hook.mjs');
  fs.writeFileSync(
    hookScript,
    `import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';const h=fs.readFileSync(0,'utf8');const r=spawnSync(process.execPath,[${JSON.stringify(root + '/apps/cli/dist/main.js')},'hook','pre-tool-use'],{input:h,encoding:'utf8',env:process.env});fs.appendFileSync(${JSON.stringify(path.join(test, 'hook-decisions.jsonl'))},JSON.stringify({tool:JSON.parse(h).tool_name,output:r.stdout.trim()})+'\\n');process.stdout.write(r.stdout);`,
  );
  const settings = path.join(test, 'settings.json');
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'mcp__grant_fixture__.*', hooks: [{ type: 'command', command: `node ${hookScript}` }] }] },
    }),
  );
  const mcp = path.join(test, 'mcp.json');
  fs.writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        grant_fixture: {
          command: process.execPath,
          args: [path.join(root, 'test/fixtures/session-grant-mcp.mjs')],
          env: { FIXTURE_LOG: log },
        },
      },
    }),
  );
  const result = spawnSync(
    'claude',
    [
      '-p',
      'Use the grant_fixture navigate tool once to navigate to https://example.com. It is an isolated harmless test stand-in. Return only its result.',
      '--permission-mode',
      'auto',
      '--permission-prompts',
      'none',
      '--strict-mcp-config',
      '--mcp-config',
      mcp,
      '--setting-sources',
      '',
      '--settings',
      settings,
      '--tools',
      '',
      '--session-id',
      session,
      '--max-turns',
      '3',
      '--max-budget-usd',
      '1',
      '--output-format',
      'json',
      '--no-session-persistence',
    ],
    { cwd: test, env: { ...process.env, LOBSTAH_HOME: process.env.LOBSTAH_HOME }, encoding: 'utf8', timeout: 120000, maxBuffer: 2000000 },
  );
  fs.writeFileSync(path.join(test, 'result.json'), result.stdout ?? '');
  fs.writeFileSync(path.join(test, 'stderr.log'), result.stderr ?? '');
  let answer;
  try {
    const r = JSON.parse(result.stdout);
    answer = { is_error: r.is_error, result: r.result, permission_denials: r.permission_denials, total_cost_usd: r.total_cost_usd };
  } catch {
    answer = { stdout: (result.stdout ?? '').slice(-1000), stderr: (result.stderr ?? '').slice(-1000) };
  }
  const observed = {
    mode,
    status: result.status,
    error: result.error?.message,
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '',
    hook: fs.existsSync(path.join(test, 'hook-decisions.jsonl'))
      ? fs.readFileSync(path.join(test, 'hook-decisions.jsonl'), 'utf8').trim()
      : '',
    answer,
  };
  results.push(observed);
  console.log(JSON.stringify(observed));
}

const baseline = results[0],
  granted = results[1];
const denied = baseline?.answer?.permission_denials?.some((d) => d.tool_name === 'mcp__grant_fixture__navigate');
const ran = !!granted?.calls;
const verified = denied && ran;
console.log(
  JSON.stringify({
    verified,
    conclusion: verified
      ? 'baseline denied; session grant allowed the real auto-mode tool call'
      : 'NOT VERIFIED: see results; account errors or an already-allowed baseline do not prove auto-mode override',
  }),
);
if (!verified) process.exitCode = 1;
