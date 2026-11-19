import readline from 'node:readline';
import { watchPluginManifest } from '../../dist/index.js';
import { FixtureProcessWatch, fixtureActionSchemas } from './process-watch.mjs';
const mode = process.argv[2];
const manifest = watchPluginManifest(new FixtureProcessWatch(), { actionSchemas: fixtureActionSchemas });
const output = (message) => process.stdout.write(JSON.stringify(message) + '\n');
for await (const text of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(text);
  if (request.method === 'watch.cancel') continue;
  if (request.method === 'watch.handshake') { output({ jsonrpc: '2.0', id: request.id, result: manifest }); continue; }
  if (mode === 'oversized') { output({ jsonrpc: '2.0', id: request.id, result: 'x'.repeat(128 * 1024) }); continue; }
  if (mode === 'wrong-id') { output({ jsonrpc: '2.0', id: 'unrequested', result: null }); continue; }
  if (mode === 'wrong-generation') {
    output({ jsonrpc: '2.0', method: 'watch.observation', params: { ...request.params, body: undefined, requestId: request.id, generation: 'stale', batch: { cursor: '99', events: [] } } });
    continue;
  }
}
