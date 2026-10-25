/**
 * The most recent failure the app can describe safely: a short code, the HTTP status and the server's request id. It lives in memory
 * only (gone on reload), holds no message text, record, report or credential, and exists so a person can quote "Error ID" in a report
 * and support can find the matching server log line.
 */

export interface ClientErrorMeta {
  /** The server's request id (X-Request-Id / `requestId` in the error body); null when the failure never reached the server. */
  requestId: string | null;
  /** A stable machine code (server error code or a client code such as SCREEN_RENDER_FAILED). */
  code: string;
  /** ISO time the failure was seen. */
  at: string;
  status?: number;
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const CODE = /^[A-Za-z0-9_.: -]{1,60}$/;

let last: ClientErrorMeta | null = null;

/** Only well-formed values are kept: an id or code that does not look like one is dropped, never stored as free text. */
export function recordClientError(input: { requestId?: unknown; code?: unknown; status?: number; now?: Date }): void {
  const requestId = typeof input.requestId === 'string' && REQUEST_ID.test(input.requestId) ? input.requestId : null;
  const code = typeof input.code === 'string' && CODE.test(input.code) ? input.code : 'error';
  last = { requestId, code, at: (input.now ?? new Date()).toISOString(), ...(input.status === undefined ? {} : { status: input.status }) };
}

export function getLastClientError(): ClientErrorMeta | null {
  return last;
}

export function clearLastClientError(): void {
  last = null;
}
