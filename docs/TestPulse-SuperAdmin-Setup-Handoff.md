# TestPulse — Super Admin Setup Handoff

**For:** the person with Cloudflare access to the `ganttchart` Worker.
**Goal:** complete the account setup so the team can use the shared workspace.
**Status of the deployment:** code is deployed and verified (routes respond correctly; all tests pass). Only the account/secret setup below remains.

---

## Prerequisites

- A Cloudflare account with access to the `ganttchart` Worker.
- Node.js 22+ installed.
- The repository checked out on the machine you'll run these from.

---

## Step 1 — Authenticate wrangler

```bash
cd worker
npx wrangler login
```

Opens a browser to authorize Cloudflare. Must be an account with access to the `ganttchart` Worker.

---

## Step 2 — Set the authentication secrets (one-time)

Run each command and paste the value when prompted:

```bash
cd worker
npx wrangler secret put SESSION_SECRET        # at least 32 random chars, e.g. `openssl rand -base64 32`
npx wrangler secret put SUPER_ADMIN_EMAILS    # e.g. admin@example.com  (comma-separated for several)
npx wrangler secret put SUPER_ADMIN_PASSWORD  # the HASH, not the password (see below)
npx wrangler secret put ACCESS_AUD            # your Access application AUD tag
```

`SUPER_ADMIN_PASSWORD` is a **hash**, generated once:

```bash
cd worker
npx tsx -e "import { hashPassword } from './src/passwords'; hashPassword('YOUR-PASSWORD').then(h => console.log(h));"
```

> **Optional:** `INTEGRATION_CREDENTIAL_KEY` is only needed if the team will use the secure Jira connector. Skip it otherwise.

---

## Step 3 — Deploy the code

```bash
cd worker
npx wrangler deploy --env=""
```

The pre-deployment guard runs automatically and aborts if anything is misconfigured.

---

## Step 4 — Sign in as Super Admin

Open `https://ganttchart.damithfdo.workers.dev` in a **private window**.
Sign in with the Super Admin email + password. The **Platform Administration** console opens.

---

## Step 5 — Create the Admin (with a workspace)

As Super Admin, create an **Admin** account. The Admin's email **must be in a managed domain** (`@rakuten.com` by default). Creating the Admin also creates their **workspace** (the shared data plane).

---

## Step 6 — Create Users

Sign in as the Admin. In the workspace, create **User** accounts for the team (managed domain only). Each User gets an initial password set by the Admin.

---

## Step 7 — Verify live sync

As a web-mode Admin/User, **open the app in two browsers**, edit something in one — the other should show it live with the header reading **"synced"**. This confirms the shared workspace and WebSocket sync are working.

---

## Step 8 — Clean up

Rename/remove the temporary maintenance Access policy once no Super Admin needs it.

---

## Quick verification (anonymous, any machine)

```bash
BASE=https://ganttchart.damithfdo.workers.dev
curl -s -o /dev/null -w "root:   %{http_code}\n" $BASE/          # 200 (public page)
curl -s -o /dev/null -w "whoami: %{http_code}\n" $BASE/api/whoami  # 401. NEVER 200
curl -s -o /dev/null -w "export: %{http_code}\n" $BASE/api/export  # 401
curl -s -o /dev/null -w "super:  %{http_code}\n" $BASE/api/super/tenants  # 401
```

**Any `200` from an `/api` path means stop and roll back** (`npx wrangler rollback`).

---

## Rollback (if needed)

1. **Code:** `npx wrangler rollback` (restores the previous Worker version; Durable Object data is untouched).
2. **Secrets:** never `wrangler secret delete` — that takes the app offline (fails closed).
3. Never `wrangler delete` the Worker — that deletes the Durable Objects and all workspaces.

---

*Full details: `docs/DEPLOYMENT_PLAN.md` in the repository.*