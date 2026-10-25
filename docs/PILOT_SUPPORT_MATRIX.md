# Pilot support matrix

What the pilot supports today. "Verified" means someone actually ran it; anything else is **not claimed**.

## Browsers

| Browser | Status |
|---|---|
| Chrome (current) | **Verified** (manual smoke, automated tests run without a browser) |
| Edge (current, Chromium) | Expected to match Chrome; verified only as far as Chromium behaviour |
| Safari | **Not verified** |
| Firefox | **Not verified** |
| Internet Explorer / old browsers | Not supported |

## Devices

| Device | Status |
|---|---|
| Desktop (primary) | Verified at 900-1920 px wide |
| Tablet | Layouts are responsive and were checked at ~900 px; execution entry on a tablet is not a pilot scenario |
| Phone | Layouts were checked at 420 px for **reading** management screens (Command Center, Improvement Analytics, Daily Report). Phone-based execution entry is **not** verified or supported |

## Modes, languages, roles

| Item | Status |
|---|---|
| Shared workspace (Cloudflare Worker + Durable Objects, Cloudflare Access sign-in) | Supported - the pilot mode |
| Local mode (no server) | Works; one person; backup files are the safety net |
| English / Japanese UI | Both supported; report language is chosen per report |
| Roles | Super Admin (workspace control only), SV (full), Tester (assigned work only) |

## Integrations

| Integration | Status |
|---|---|
| JIRA | Data Center (Personal Access Token) and Cloud (email + API token) are handled by the client; the pilot is expected to use the configured instance through a proxy. Cloud has had less real-world use |
| TestRail | Case import uses `get_cases/{project_id}&suite_id={suite_id}`; run/test sync; custom statuses are not configurable (counted as "in progress") |
| Proxies | HTTPS required (localhost excepted); read-only; credentials stay on the device |
| Cloudflare Access | Required for the shared workspace; the app verifies the Access token itself |

See also [SECURITY.md](../SECURITY.md) and Settings -> Support & Pilot -> Known Limitations.
