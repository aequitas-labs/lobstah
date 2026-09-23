import { describe, expect, it } from 'vitest';
import { explainRefusal, resolveSessionId } from '../src/session-id.js';

const env = { CLAUDE_CODE_SESSION_ID: 'env-id' } as NodeJS.ProcessEnv;

describe('resolveSessionId — one precedence rule for the calling session', () => {
  it('explicit --session beats stdin and env', () => {
    expect(resolveSessionId({ flag: 'flag-id', stdin: () => 'stdin-id', env })).toEqual({
      id: 'flag-id',
      source: 'flag',
      from: '--session',
    });
  });

  it('hook stdin beats env when no flag is given', () => {
    expect(resolveSessionId({ stdin: () => 'stdin-id', env })).toMatchObject({ id: 'stdin-id', source: 'stdin' });
  });

  it('falls back to $CLAUDE_CODE_SESSION_ID when neither flag nor stdin carries one', () => {
    expect(resolveSessionId({ stdin: () => undefined, env })).toEqual({
      id: 'env-id',
      source: 'env',
      from: '$CLAUDE_CODE_SESSION_ID',
    });
    expect(resolveSessionId({ env })).toMatchObject({ id: 'env-id', source: 'env' });
  });

  it('env is ignored when --session is present, and stdin is never read then', () => {
    let read = false;
    const r = resolveSessionId({ flag: 'flag-id', stdin: () => ((read = true), 'stdin-id'), env });
    expect(r?.id).toBe('flag-id');
    expect(read).toBe(false);
  });

  it('nothing anywhere resolves to undefined; blank env does not count', () => {
    expect(resolveSessionId({ env: {} as NodeJS.ProcessEnv })).toBeUndefined();
    expect(resolveSessionId({ env: { CLAUDE_CODE_SESSION_ID: '  ' } as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it('does not guess a Codex env name (none is documented)', () => {
    expect(resolveSessionId({ env: { CODEX_THREAD_ID: 'x', CODEX_SESSION_ID: 'y' } as NodeJS.ProcessEnv })).toBeUndefined();
  });
});

describe('explainRefusal', () => {
  it('names the discovered id and its source', () => {
    const msg = explainRefusal('reserved for the helm session.', { id: 'env-id', source: 'env', from: '$CLAUDE_CODE_SESSION_ID' });
    expect(msg).toContain('env-id');
    expect(msg).toContain('$CLAUDE_CODE_SESSION_ID');
  });

  it('names an explicit --session as the source', () => {
    expect(explainRefusal('nope', { id: 'x', source: 'flag', from: '--session' })).toBe('nope (resolved session x from --session)');
  });

  it('says so when no session was given or resolved', () => {
    expect(explainRefusal('nope', undefined)).toBe('nope (no --session given and none resolved from the environment)');
  });
});
