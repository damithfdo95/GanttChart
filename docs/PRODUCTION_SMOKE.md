# Production smoke checklist

Run after every deploy (about ten minutes). Use a real SV account, plus a Tester account for the permission checks. Record result, tester and time in the pilot release notes.
Base URL checks (unauthenticated) are the `curl` lines in [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

- [ ] **Login** - sign in through Cloudflare Access; Settings -> Support & Pilot shows the expected version, commit and `Pilot` channel.
- [ ] **Shared sync** - status shows Synced; edit something on this device and see it on a second device (or reload); then undo the edit.
- [ ] **Dashboard** - loads with the project data; no error banner.
- [ ] **Command Center** - situation, attention list and daily-report block render for today.
- [ ] **Test Management** - scopes and cases list; open one case's history.
- [ ] **JIRA / TestRail** - Test Connection succeeds (if configured); a failed connection shows a clear message and the rest of the app still works.
- [ ] **Daily Report** - Prepare -> draft -> finalize on a scratch date (or view an existing finalized one).
- [ ] **Publishing** - Copy Plain Text / Copy for Teams-Slack work; Mark as Published asks for confirmation (use a scratch report).
- [ ] **Improvement Analytics** - opens for 30 and 90 days; partial-history warning appears when expected.
- [ ] **Backup export** - Reports & Export -> full backup downloads; (weekly) restore it in a scratch profile.
- [ ] **Tester check** - a Tester cannot see Command Center, Improvement Analytics, Settings or Daily Report.
- [ ] **Errors** - a deliberately wrong action shows a message with an Error ID, no stack trace.

If any box fails: do not announce the release; fix forward, or roll back for a severe failure ([PILOT_OPERATIONS.md](PILOT_OPERATIONS.md)).
