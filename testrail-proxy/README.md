# testrail-proxy

A one-file Cloudflare Worker that lets the GanttChart app talk to a TestRail
instance from the browser. TestRail never sends CORS headers, so direct
browser calls are blocked; this worker forwards API requests (with the
caller's Basic-auth Authorization header) to the TestRail root configured in
`wrangler.toml` and adds the CORS headers TestRail lacks. No credentials are
stored in the worker.

## Deploy

```powershell
cd testrail-proxy
npx wrangler deploy
```

The URL is printed at the end, e.g. `https://testrail-proxy.<account>.workers.dev`.

## Use in the app

Settings → TestRail Integration:

- **Base URL**: the real TestRail root, e.g. `https://rkong.testrail.com`
- **Email + API key**: your TestRail login email and API key
  (TestRail → My Settings → API Keys)
- **Proxy URL**: the worker URL printed by `wrangler deploy`

Then press **Test Connection**, and use Test Management → Scopes →
Import from TestRail with a plan URL.

## Changing the TestRail target

Edit `TESTRAIL_ORIGIN` in `wrangler.toml` (or set it as a var in the
Cloudflare dashboard) and redeploy.

## Notes

- Hardened: only `/index.php?/api/v2/…` requests are forwarded, and CORS is
  granted only to `APP_ORIGIN`
  (`https://ganttchart.damithfdo.workers.dev` — edit it in `src/worker.js` if
  the app moves). Anyone can still reach TestRail with valid credentials of
  their own; for tighter control use Cloudflare Access or an unguessed
  subdomain.
- API-key hygiene: TestRail API keys can be regenerated from user settings;
  revoke keys that are no longer used.
