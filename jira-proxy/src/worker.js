/**
 * Minimal CORS forwarder for the GanttChart app's JIRA integration.
 *
 * The app (Settings → JIRA Integration → Proxy URL) calls this worker with the
 * ORIGINAL JIRA path appended, e.g.
 *
 *   https://jira-proxy.<account>.workers.dev/rest/api/2/search
 *       -> https://jira.rakuten-it.com/jira/rest/api/2/search
 *
 * The caller's Authorization header (the JIRA PAT for Data Center) is relayed
 * as-is; nothing is stored here. Every response carries the CORS headers JIRA
 * itself never sends.
 *
 * Hardening:
 *   - Only /rest/* paths are forwarded (the JIRA REST API the app uses);
 *     anything else is a 404.
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
    if (!url.pathname.startsWith('/rest/')) return new Response('Not found', { status: 404 });

    const origin = String(env.JIRA_ORIGIN ?? '').replace(/\/+$/, '');
    if (origin === '') return new Response('JIRA_ORIGIN not configured', { status: 500, headers: CORS });

    const upstream = origin + url.pathname + url.search;

    // Only the headers JIRA needs; browser cookies and friends are not relayed.
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
