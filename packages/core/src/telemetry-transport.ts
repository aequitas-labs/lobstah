import * as http from 'node:http';
import * as https from 'node:https';

/** One fresh connection per daily anonymous POST. Never the wharf's fetch pool,
 * credential store, cookie jar, headers or redirect chain. */
export function anonymousTelemetryPost(endpoint: string, init: RequestInit): Promise<Response> {
  const url = new URL(endpoint);
  if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    return Promise.reject(new Error('invalid telemetry endpoint'));
  const body = typeof init.body === 'string' ? init.body : '';
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', agent: false, signal: init.signal ?? undefined,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      response.on('error', () => {}); // An aborted response cannot crash the daemon.
      response.resume(); // No response content is needed or retained.
      resolve(new Response(null, { status: response.statusCode ?? 500 }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
