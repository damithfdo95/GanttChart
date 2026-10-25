# Pilot operations

Practical routines for the supervisor and the owner during the pilot.

## Daily (SV)

1. Open the **Command Center** - situation, attention items, today's execution.
2. Sync integrations only if needed (TestRail / JIRA imports are explicit actions; nothing syncs by itself).
3. Verify **staffing** (planned / assigned / actual) and **execution** for the day.
4. **Prepare the Daily Report**, review, **finalize**, then copy / export and mark **Published** once delivered.
5. Record issues: feedback report ([PILOT_FEEDBACK.md](PILOT_FEEDBACK.md)) and the pilot diary line.

## Weekly

- **Export a full backup** (Reports & Export) and store the file somewhere you control.
- Review **Improvement Analytics** (30 days; 90 when useful).
- Review unresolved feedback and decide what to fix first.
- Check integration health: use **Test Connection** in Settings for JIRA and TestRail (no check runs automatically).

## Backup cadence

- Regular full workspace backup - **at least weekly**, and **daily while the pilot is young**.
- Always before: an upgrade/deploy, a big import, a bulk change, or changing integration/QA-policy settings.
- Keep the last several files. Nothing is scheduled or uploaded externally by the app; the optional automatic daily backup writes to a folder you choose on that device.

## Restore drill (no production restore needed)

Do this once before the pilot and after major releases, in a **separate browser profile** (or `npm run dev` locally):

1. Export a full backup from the real workspace.
2. In the clean profile open the app (local mode), Reports & Export -> Restore, choose the file, confirm.
3. Check: project count and names; a project's daily execution and Gantt; Test Management scopes (work types), cases and a case's history; the Daily Report list (a finalized and a published report keep their status); QA policy in Settings; Team Members.
4. Check that **no JIRA/TestRail credentials** came with the file (they are device-local) and re-enter them if needed.
5. Note date, file, result. A failed drill is a Bug/Data issue: report it.

## Rollback drill (written down; do not rehearse on production)

Use the real mechanisms only:

- **Bad frontend deployment:** redeploy the previous good build (check out the previous release tag, `npm run build`, deploy the Worker so the assets are republished), or roll back the Worker version in Cloudflare (`wrangler rollback` / dashboard) when assets ship with it. Users with the broken page see a "newer version - reload" recovery screen, not a blank page.
- **Bad Worker deployment:** roll back to the previous Worker version (a deployment id, not a git tag). Durable Object migrations are forward-only; do not roll back across one without a plan.
- **Data issue:** SV opens Audit History, previews a revision and restores it (creates a new revision); or restore a backup file. History is kept for the retention period only.
- **Integration outage:** nothing to roll back - JIRA/TestRail are optional and read-only. The rest of the app, including the Command Center and reports, keeps working from saved data; retry imports later (they are idempotent).

Prefer **roll forward** for small issues (see [PILOT_RELEASE.md](PILOT_RELEASE.md)).

## Post-release monitoring checklist (manual - no automated monitoring exists)

After each deploy and smoke test, for the first day:

- [ ] Sign-in works for an SV and a Tester.
- [ ] Cloudflare Worker logs / error rate (if visible in the dashboard) look normal; note any `requestId` in reports.
- [ ] Shared sync indicator shows Synced; an edit appears on a second device.
- [ ] JIRA / TestRail Test Connection succeeds (if used).
- [ ] A Daily Report can be prepared and finalized.
- [ ] A backup export downloads and restores in the drill profile (weekly is enough).
- [ ] Ask the SV for any friction; log it as feedback.

## Management onboarding checklist (documentation, not a wizard)

1. Create the **project** (plan, total cases, planned testers per day).
2. Configure **scopes** and set each scope's **work type**.
3. Set **TestRail / JIRA** connections (device-local; HTTPS proxy addresses) and test them.
4. Add **Team Members**; create Tester accounts where needed.
5. **Assign testers** to projects/scopes.
6. Set **Planned Testers** per day.
7. Enter or sync **execution** (Daily Execution; TestRail sync; case results).
8. Use the **Command Center** for the daily view.
9. **Prepare** the Daily Report, finalize and publish.
10. Review **Improvement Analytics** after a week or two of data.
