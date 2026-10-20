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
const APP_ORIGIN = 'https://ganttchart.damithfdo.workers.dev';

const CORS = {
  'Access-Control-Allow-Origin': APP_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      // Preflight is only answered for the app's origin.
      if (request.headers.get('Origin') !== APP_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    // TestRail's whole API is /index.php with the command in the query string.
    if (url.pathname !== '/index.php' || !url.search.startsWith('?/api/v2/')) {
      return new Response('Not found', { status: 404 });
    }

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
