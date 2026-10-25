/**
 * Minimal CORS forwarder for the GanttChart app's TestRail integration.
 *
 * TestRail never sends CORS headers, so browsers cannot call it directly. The
 * app (Settings → TestRail Integration → Proxy URL) calls this worker with the
 * ORIGINAL TestRail request appended:
 *
 *   https://testrail-proxy.<account>.workers.dev/index.php?/api/v2/get_run/103
 *       -> https://rkong.testrail.com/index.php?/api/v2/get_run/103
 *
 * The caller's Authorization header (HTTP Basic: email + TestRail API key) is
 * relayed as-is; nothing is stored here. Every response carries the CORS
 * headers TestRail itself never sends.
 *
 * Hardening (mirrors jira-proxy):
 *   - Only the API is forwarded: path must be exactly /index.php AND the query
 *     must start with /api/v2/ (TestRail's documented URL shape
 *     `index.php?/api/v2/<method>&<query>…`); anything else is a 404.
 *   - CORS is granted to APP_ORIGIN only, so other websites cannot relay
 *     through a visitor's browser.
 */
const DEFAULT_APP_ORIGIN = 'https://ganttchart.damithfdo.workers.dev';

/**
 * Simple per-isolate rate limit: at most RATE_LIMIT_MAX requests per client IP
 * per RATE_LIMIT_WINDOW ms. Best-effort (resets when the isolate recycles) —
 * enough to blunt abuse on a free-plan relay, not a hard guarantee.
 */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const hits = new Map();

/**
 * A path that tries to leave the allowed API: encoded dots or slashes, backslashes, control characters or a NUL. The URL parser already
 * folds literal ../ segments; the encoded forms must not reach the upstream, where a server may decode them differently.
 */
const SUSPICIOUS_PATH = /%2e|%2f|%5c|%00|\\|[\u0000-\u001f\u007f]/i;

/** Read-only relay: the app only reads from TestRail, so only GET/HEAD are forwarded. */
const METHOD_ALLOWED = (method) => method === 'GET' || method === 'HEAD';

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (entry === undefined || now - entry.start >= RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

export default {
  async fetch(request, env) {
    const APP_ORIGIN = String(env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN);
    const CORS = {
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') {
      // Preflight is only answered for the app's origin.
      if (request.headers.get('Origin') !== APP_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: CORS });
    }

    if (rateLimited(request.headers.get('CF-Connecting-IP') ?? 'unknown')) {
      return new Response('Too many requests', { status: 429, headers: CORS });
    }

    const url = new URL(request.url);
    // TestRail's whole API is /index.php with the command in the query string.
    if (url.pathname !== '/index.php' || !url.search.startsWith('?/api/v2/') || SUSPICIOUS_PATH.test(url.search.split('&')[0])) {
      return new Response('Not found', { status: 404 });
    }
    if (!METHOD_ALLOWED(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...CORS, Allow: 'GET, HEAD' } });

    const origin = String(env.TESTRAIL_ORIGIN ?? '').replace(/\/+$/, '');
    if (origin === '') return new Response('TESTRAIL_ORIGIN not configured', { status: 500, headers: CORS });

    const upstream = origin + url.pathname + url.search;

    // Only the headers TestRail needs; browser cookies and friends are not relayed.
    const headers = { Accept: 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth !== null) headers.Authorization = auth;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers['Content-Type'] = request.headers.get('Content-Type') ?? 'application/json';
    }

    const res = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });

    const out = new Response(res.body, res);
    // CORS headers only for the app's origin; a bare curl sees the plain response.
    if (request.headers.get('Origin') === APP_ORIGIN) {
      for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    }
    return out;
  },
};
