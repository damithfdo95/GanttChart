# jira-proxy

A one-file Cloudflare Worker that lets the GanttChart app talk to a JIRA
instance from the browser. JIRA sends no CORS headers, so direct browser calls
are blocked; this worker forwards every request (with the caller's
Authorization header) to the JIRA root configured in `wrangler.toml` and adds
the CORS headers JIRA lacks. No credentials are stored in the worker.

## Deploy

```powershell
cd jira-proxy
npx wrangler deploy
```

The URL is printed at the end, e.g. `https://jira-proxy.<account>.workers.dev`.

## Use in the app

Settings → JIRA Integration:

- **Base URL**: the real JIRA root, e.g. `https://jira.rakuten-it.com/jira`
  (Cloud/Data Center detection uses this host, not the proxy host)
- **Type**: Data Center (auto-detected), **Email** left empty
- **API token / PAT**: your JIRA Personal Access Token
- **Proxy URL**: the worker URL printed by `wrangler deploy`

Then press **Test Connection**.

## Changing the JIRA target

Edit `JIRA_ORIGIN` in `wrangler.toml` (or set it as a secret/var in the
Cloudflare dashboard) and redeploy.

## Notes

- Hardened: only `/rest/*` paths are forwarded, and CORS is granted only to
  `APP_ORIGIN` (`https://ganttchart.damithfdo.workers.dev` — edit it in
  `src/worker.js` if the app moves). Anyone can still relay to this JIRA with
  a valid PAT of their own; for tighter control use Cloudflare Access or an
  unguessed subdomain.
- If Rakuten's WAF blocks Cloudflare IP ranges, Test Connection will fail with
  429/network errors; in that case the proxy must run somewhere the WAF accepts
  (e.g. inside the corporate network) with HTTPS in front of it.
- PAT hygiene: create JIRA Personal Access Tokens with an expiry date and
  revoke them when no longer needed.
