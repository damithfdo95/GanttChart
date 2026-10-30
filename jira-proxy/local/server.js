/**
 * Local HTTPS CORS forwarder for the GanttChart app's JIRA integration.
 *
 * This is the "Option A" deployment: run this server on a machine INSIDE the
 * corporate network (so it can reach the internal JIRA host), expose it over
 * HTTPS, and put a Cloudflare Tunnel in front of it so the browser can reach
 * it from anywhere. It mirrors the Cloudflare Worker in `src/worker.js` but
 * runs as a plain Node HTTPS server.
 *
 * Request flow:
 *
 *   Browser -> Cloudflare Tunnel -> https://localhost:PORT/rest/api/2/search
 *       -> https://jira.rakuten-it.com/jira/rest/api/2/search
 *
 * The caller's Authorization header (the JIRA PAT for Data Center) is relayed
 * as-is; nothing is stored here. Every response carries the CORS headers JIRA
 * itself never sends.
 *
 * Hardening (same as the Worker):
 *   - Only /rest/* paths are forwarded; anything else is a 404.
 *   - CORS is granted to APP_ORIGIN only, so other websites cannot relay
 *     through a visitor's browser.
 *   - Read-only relay: GET/HEAD, plus POST only for the JQL search the app
 *     uses. Nothing is ever written to JIRA through this server.
 *
 * TLS: the tunnel terminates TLS, so this server can run on plain HTTP on
 * localhost. If you run it WITHOUT a tunnel (directly exposed), terminate TLS
 * here instead (see the TLS section below).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration (override via environment variables)
// ---------------------------------------------------------------------------

/** The JIRA root this server forwards to (Data Center base URL, incl. /jira context path). */
const JIRA_ORIGIN = (process.env.JIRA_ORIGIN || 'https://jira.rakuten-it.com/jira').replace(/\/+$/, '');

/** The origin allowed to call this proxy (CORS). */
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://ganttchart.damithfdo.workers.dev';

/** Port to listen on. Behind a tunnel this is a localhost port. */
const PORT = Number(process.env.PORT || 8787);

/**
 * Optional TLS termination here (only if NOT using a tunnel). Set TLS_CERT and
 * TLS_KEY to .pem file paths to serve HTTPS directly. Leave unset to serve
 * plain HTTP (recommended behind a Cloudflare Tunnel).
 */
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

// ---------------------------------------------------------------------------
// Rate limiting (best-effort, per client IP)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Path / method hardening (same rules as the Worker)
// ---------------------------------------------------------------------------

/** Encoded dots/slashes, backslashes, control chars or NUL must not reach upstream. */
const SUSPICIOUS_PATH = /%2e|%2f|%5c|%00|\\|[\u0000-\u001f\u007f]/i;

/** Read-only relay: GET/HEAD, plus POST only for the JQL search the app uses. */
function methodAllowed(method, pathname) {
  if (method === 'GET' || method === 'HEAD') return true;
  return method === 'POST' && /^\/rest\/api\/(2|3)\/search(\/jql)?$/.test(pathname);
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function send(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handle(req, res) {
  const CORS = corsHeaders();
  const origin = req.headers.origin || '';

  // Preflight: only answered for the app's origin.
  if (req.method === 'OPTIONS') {
    if (origin !== APP_ORIGIN) return send(res, 403, 'Forbidden', CORS);
    return send(res, 204, null, CORS);
  }

  // Rate limit by client IP (tunnel sets X-Forwarded-For; fall back to socket).
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return send(res, 429, 'Too many requests', CORS);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/rest/') || SUSPICIOUS_PATH.test(url.pathname)) {
    return send(res, 404, 'Not found', CORS);
  }
  if (!methodAllowed(req.method, url.pathname)) {
    return send(res, 405, 'Method not allowed', { ...CORS, Allow: 'GET, HEAD' });
  }

  const upstream = JIRA_ORIGIN + url.pathname + url.search;

  // Only the headers JIRA needs; browser cookies and friends are not relayed.
  const headers = { Accept: 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['Content-Type'] = req.headers['content-type'] || 'application/json';
  }

  const upstreamReq = https.request(
    upstream,
    { method: req.method, headers },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      // CORS headers only for the app's origin; a bare curl sees the plain response.
      if (origin === APP_ORIGIN) {
        for (const [k, v] of Object.entries(CORS)) outHeaders[k] = v;
      }
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err) => {
    // The upstream (internal JIRA) is unreachable — e.g. this server is not on
    // the corporate network, or JIRA is down. Report a clear 502.
    console.error(`[jira-proxy] upstream error for ${upstream}: ${err.message}`);
    if (!res.headersSent) send(res, 502, 'Bad gateway: could not reach the JIRA server.', CORS);
    else res.end();
  });

  // Forward the request body (POST search) if present.
  req.pipe(upstreamReq);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let server;
if (TLS_CERT && TLS_KEY) {
  const options = {
    cert: fs.readFileSync(path.resolve(TLS_CERT)),
    key: fs.readFileSync(path.resolve(TLS_KEY)),
  };
  server = https.createServer(options, handle);
  console.log(`[jira-proxy] serving HTTPS on :${PORT}`);
} else {
  server = http.createServer(handle);
  console.log(`[jira-proxy] serving HTTP on :${PORT} (terminate TLS at the tunnel/edge)`);
}

server.listen(PORT, () => {
  console.log(`[jira-proxy] listening on :${PORT}`);
  console.log(`[jira-proxy] forwarding to ${JIRA_ORIGIN}`);
  console.log(`[jira-proxy] CORS allowed for ${APP_ORIGIN}`);
});