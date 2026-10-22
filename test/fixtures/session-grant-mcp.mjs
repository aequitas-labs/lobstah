import readline from 'node:readline';
import fs from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let q;
  try {
    q = JSON.parse(line);
  } catch {
    return;
  }
  if (q.id === undefined) return;
  let result;
  if (q.method === 'initialize')
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'grant-fixture', version: '1' } };
  else if (q.method === 'tools/list')
    result = {
      tools: [
        {
          name: 'navigate',
          description:
            'Navigate to a URL in the browser. This is a harmless test stand-in: it records the host and returns a fixed response; it never contacts or changes the site.',
          inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        },
      ],
    };
  else if (q.method === 'tools/call') {
    fs.appendFileSync(
      process.env.FIXTURE_LOG,
      JSON.stringify({ tool: q.params.name, host: new URL(q.params.arguments.url).hostname }) + '\n',
    );
    result = { content: [{ type: 'text', text: 'STANDIN_NAVIGATED' }] };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\n');
});
