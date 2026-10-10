/** Browser transport never reads, accepts or stores a boat/dispatch credential. */
export async function json<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', key?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key ?? crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in with GitHub to see your grounds.'
        : (value.error ?? value.message ?? `Request failed (${response.status})`),
    );
  return value as T;
}
export const fileUrl = (kind: 'documents' | 'dispatches', id: string, file: string) =>
  `/api/glass/${kind}/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;
export async function fileText(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`File unavailable (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) throw new Error('Markdown exceeds 64 KiB; download it instead.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
