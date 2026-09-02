import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { cancelTool, dispatchTool, sendTool, statusTool } from './tools.js';

/**
 * OpenClaw plugin surface for lobstah. Fleet agents get typed tools that
 * translate into queue descriptors and file reads on this host; operators get
 * a /lobstah status command. Additive by design: the file queue and CLI stay
 * the primary path, and nothing in lobstah core imports from this package.
 */
export default definePluginEntry({
  id: 'lobstah',
  name: 'Lobstah',
  description: 'Dispatch supervised local coding-agent work through the lobstah daemon on this host.',
  register(api) {
    api.registerTool(dispatchTool(), { optional: true });
    api.registerTool(statusTool(), { optional: true });
    api.registerTool(sendTool(), { optional: true });
    api.registerTool(cancelTool(), { optional: true });
    api.registerCommand({
      name: 'lobstah',
      description: 'Lobstah dispatch status on this host (/lobstah [id])',
      acceptsArgs: true,
      async handler(ctx) {
        const tool = statusTool();
        const arg = ctx.args?.trim();
        const result = await tool.execute('cmd', arg ? { id: arg } : {});
        return { text: result.content[0]?.text ?? 'no output' };
      },
    });
  },
});
