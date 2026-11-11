export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

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
    throw new HttpError(
      response.status,
      response.status === 401
        ? 'Sign in with GitHub to see your grounds.'
        : (value.error_description ?? value.error ?? value.message ?? 'Something went wrong. Try again.'),
    );
  return value as T;
}
