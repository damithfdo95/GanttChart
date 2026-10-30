# JIRA proxy — Option A (local server + Cloudflare Tunnel)

This is the **recommended, secure** way to let the GanttChart app reach the
internal JIRA instance (`jira.rakuten-it.com`).

## Why this is needed

The public Cloudflare Worker (`jira-proxy.damithfdo.workers.dev`) cannot reach
`jira.rakuten-it.com` because that host is **internal-only** — it is reachable
from inside the Rakuten corporate network but not from Cloudflare's edge. That
is why Test Connection returns **HTTP 522** (Cloudflare "connection timed out").

The fix: run the proxy **inside the corporate network** so it can reach JIRA,
and expose it over HTTPS via a **Cloudflare Tunnel** so the browser can reach
it from anywhere. The tunnel is an *outbound* connection from inside the
network to Cloudflare, so **no inbound firewall rule or public IP is needed**
on the JIRA host.

## ⚠️ HTTPS is required (mixed-content)

The app is served over **HTTPS** (e.g. `https://ganttchart.damithfdo.workers.dev`).
A page served over HTTPS **cannot** call a plain `http://` proxy — browsers
block it as **mixed content**, and the request never reaches the proxy. You
will see *"The JIRA request failed at the network level"* even though the
server is running and reachable.

So the **Proxy URL must be `https://`**. Two ways to get that:

- **Cloudflare Tunnel** (below) — gives a real `https://` hostname with a
  valid certificate. **Recommended**, no cert hassle.
- **Local TLS** (PC1 only) — run the server with a self-signed cert and use
  `https://localhost:8787`. You must trust the cert in the browser. See
  "PC1-only (no tunnel)" below.

## PC1-only (no tunnel)

If the browser is on the **same internal machine** as the proxy (PC1), you can
skip the tunnel and run the server with TLS directly:

```powershell
# Generate a self-signed cert (one time)
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"

# Run with TLS
$env:TLS_CERT = "cert.pem"
$env:TLS_KEY  = "key.pem"
npm start
```

Then in the app use **Proxy URL** = `https://localhost:8787`. You must trust
`cert.pem` in the browser (open `https://localhost:8787` once and accept the
warning). This only works when the app and proxy are on the same machine.

## Architecture

```
Browser (GanttChart app)
   │  Proxy URL = https://jira-proxy.yourdomain.com
   ▼
Cloudflare Tunnel (public hostname, TLS terminated)
   │  outbound connection from inside the network
   ▼
Local Node server (jira-proxy/local/server.js)  ← on the corporate network
   │  forwards /rest/* to JIRA_ORIGIN
   ▼
https://jira.rakuten-it.com/jira/rest/api/2/search
```

## Files

| File | Purpose |
|---|---|
| `local/server.js` | The hardened Node HTTPS/HTTP forwarder (mirrors the Worker logic). |
| `local/package.json` | `npm start` runs the server. |
| `local/config.yml` | Cloudflare Tunnel ingress config. |

## Setup

### 1. Install and run the local server (on an internal host)

Pick a machine that is on the Rakuten corporate network and can reach
`jira.rakuten-it.com` (verify with `curl -I https://jira.rakuten-it.com/jira/rest/api/2/serverInfo`).

```powershell
cd jira-proxy/local
npm start
```

By default it listens on `http://localhost:8787` and forwards to
`https://jira.rakuten-it.com/jira`. Override with environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `JIRA_ORIGIN` | `https://jira.rakuten-it.com/jira` | The JIRA root to forward to. |
| `APP_ORIGIN` | `https://ganttchart.damithfdo.workers.dev` | The only origin allowed CORS. |
| `PORT` | `8787` | Local listen port. |
| `TLS_CERT` / `TLS_KEY` | *(empty)* | Optional: terminate TLS here instead of at the tunnel. |

### 2. Set up the Cloudflare Tunnel

```powershell
# Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
cloudflared tunnel login
cloudflared tunnel create jira-proxy
```

Edit `local/config.yml` and set the `hostname` to your real public hostname
(e.g. `jira-proxy.yourdomain.com`), and point `credentials-file` at the
`jira-proxy.json` that `cloudflared tunnel create` generated.

Then run the tunnel:

```powershell
cloudflared tunnel --config config.yml run jira-proxy
```

### 3. (Recommended) Gate it with Cloudflare Access

Add a **Cloudflare Access** (Zero Trust) application for the tunnel hostname,
requiring corporate SSO. This ensures only authorized users can reach the
proxy, on top of the app's own PAT.

### 4. Configure the app

Settings → JIRA Integration:

- **Base URL**: `https://jira.rakuten-it.com/jira`
- **Type**: Data Center (auto-detected), **Email** left empty
- **API token / PAT**: your JIRA Personal Access Token
- **Proxy URL**: `https://jira-proxy.yourdomain.com` (the tunnel hostname)

Then press **Test Connection**.

## Security notes

- **JIRA stays fully internal.** No inbound firewall rule, no public IP, no
  port opened on the JIRA host.
- **No credentials stored.** The browser holds the PAT; the server and tunnel
  only relay it.
- **Hardened relay.** Only `/rest/*` paths are forwarded; CORS is granted only
  to `APP_ORIGIN`; read-only (GET/HEAD, plus POST only for the JQL search).
- **Cloudflare Access** adds an SSO gate and an audit log.
- **PAT hygiene:** create JIRA Personal Access Tokens with an expiry date and
  revoke them when no longer needed.

## Troubleshooting

- **"The JIRA request failed at the network level" but the server is running:**
  the Proxy URL is probably `http://` while the app is served over `https://`
  (mixed content). Use an `https://` Proxy URL (tunnel hostname, or
  `https://localhost:8787` with a trusted self-signed cert).
- **Test Connection still fails with 522/network errors:** the local server is
  not on the corporate network, or the tunnel isn't running. Verify the server
  can reach JIRA directly (`curl -I .../serverInfo`).
- **CORS errors in the browser:** confirm `APP_ORIGIN` matches the address the
  app is served from.
- **403 on preflight:** the request's `Origin` is not `APP_ORIGIN`.