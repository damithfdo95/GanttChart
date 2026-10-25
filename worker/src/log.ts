/**
 * Structured server logging. One JSON line per event, with a stable event name and small, non-content fields only: reason codes,
 * counts, roles, a request id. Never a token, an Authorization header, a record body, a report text, a memo or a mailbox name.
 * Cloudflare's observability collects these lines; the request id connects one to the error a person saw in the browser.
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** An exception reduced to its type and a short single-line message (no stack, bounded length). */
export function safeError(error: unknown): string {
  // Only the first line of the message: anything after it is usually a stack or a payload.
  const first = (text: string): string => (text.split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').slice(0, 160);
  if (error instanceof Error) return first(`${error.name}: ${error.message}`);
  return first(String(error));
}

/** A fresh opaque id for one request: random, never derived from anything the caller sent (so it cannot be used to forge log lines). */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Stamp a Worker API response with its request id: the X-Request-Id header on everything, plus a `requestId` field in the body of a
 * JSON error. WebSocket upgrades are returned untouched (a rebuilt Response would lose the socket).
 */
export async function withRequestId(response: Response, requestId: string): Promise<Response> {
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket != null) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  const type = headers.get('Content-Type') ?? '';
  if (response.status >= 400 && type.includes('application/json')) {
    const text = await response.text();
    try {
      const body: unknown = JSON.parse(text);
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        headers.delete('Content-Length');
        return new Response(JSON.stringify({ ...(body as Record<string, unknown>), requestId }), { status: response.status, statusText: response.statusText, headers });
      }
    } catch {
      /* not JSON after all: fall through with the original text */
    }
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
