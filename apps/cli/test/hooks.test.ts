import { describe, expect, it } from 'vitest';
import { mergeHaulHook } from '../src/hooks.js';

describe('mergeHaulHook', () => {
  it('creates the structure from nothing', () => {
    const { settings, changed } = mergeHaulHook(undefined);
    expect(changed).toBe(true);
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('lobstah man haul');
  });

  it('is idempotent', () => {
    const first = mergeHaulHook({});
    const second = mergeHaulHook(first.settings);
    expect(second.changed).toBe(false);
    expect(second.settings.hooks?.Stop).toHaveLength(1);
  });

  it('preserves existing hooks and settings verbatim', () => {
    const existing = {
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'my-other-hook.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
      },
    };
    const { settings, changed } = mergeHaulHook(existing);
    expect(changed).toBe(true);
    expect(settings.model).toBe('opus');
    expect(settings.hooks?.Stop).toHaveLength(2);
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('my-other-hook.sh');
    expect((settings.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
  });
});
