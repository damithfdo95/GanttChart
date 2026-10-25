# Recovery procedures

Short, practical procedures. They describe what the product and Cloudflare/GitHub actually provide; anything not listed here
(automatic failover, point-in-time database recovery, customer self-service restore) is **not** available.

## Bad frontend deployment (the UI is broken, the Worker is fine)

1. Re-deploy the previous good commit's build (`git checkout <good tag>`, `npm run build`, then the normal Worker deploy so the
   assets are republished) - or use Cloudflare's version rollback for the Worker deployment if the assets were bundled in it.
2. Users with the broken page open see "A newer version is available - reload" (the error boundary) rather than a blank screen.
3. No data is affected: the UI never rewrites data on load beyond its documented migrations.

## Bad Worker deployment

1. Roll back to the previous Worker version in Cloudflare (`wrangler rollback` or the dashboard) - a deployment id, not a git tag.
2. `worker/` has a production safety guard (`npm run validate`) that blocks deploys with missing bindings/vars/doc entries; run it first.
3. Durable Object schema migrations in `wrangler.jsonc` are **forward-only**: do not roll back across a migration tag without a plan.

## Data problem in a shared workspace (wrong edit, bad import)

1. An SV opens **Audit History** → previews a revision → restores it. Restoring creates a *new* revision (nothing is deleted).
2. Revision history is retained for `HISTORY_RETENTION_DAYS` (30 by default); older revisions are pruned.
3. For something larger, restore a **backup file** (Reports & Export → Restore). A backup of the current data is downloaded first.

## Corrupted local data (local mode or one device)

1. The app detects an unreadable local store, keeps the damaged payload aside (recovery snapshot) and starts from defaults instead of
   overwriting it.
2. Restore the most recent backup file (manual export or the optional automatic daily backup folder).
3. If a shared workspace exists, signing in re-downloads the workspace; local device data is only a cache of it.

## Shared workspace restore

Only the workspace's own SV can restore (revision restore or backup replace). The Super Admin cannot read or restore workspace data.
Replacing a workspace from a backup is one revision and is itself restorable from history.

## A secret was exposed

1. **Do not** wait: rotate it at the source. `ACCESS_AUD` / `SUPER_ADMIN_EMAILS`: `wrangler secret put` a new value and redeploy;
   a JIRA token / TestRail API key: revoke it in JIRA/TestRail and create a new one, then paste it again in Settings on each SV device.
2. If it reached Git: removing the file does not remove it from history; treat the value as public and rotate. Rewriting history is a
   separate, deliberate decision.
3. Integration credentials are device-local, so an exposed backup or sync record cannot contain them - but verify with a search.

## Integration outage (JIRA / TestRail / proxy)

The integrations are optional and read-only. If one is down, imports and sync from it fail with a typed message (authentication,
permission, rate limit, proxy rejected, network); nothing in the workspace changes. Test Connection in Settings shows the category.
Existing case histories and daily executions are unaffected; re-run the import when the service returns (imports are idempotent).
