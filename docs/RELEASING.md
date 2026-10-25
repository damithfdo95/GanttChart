# Releasing

Releases are **manual**: this repository does not automate pushing or deploying. This page is the checklist, the version rules,
the bundle budget and the supported-browser assumptions.

## Version authority

There are four different identifiers; they answer different questions and must not be confused:

| Identifier | Answers | Where |
|---|---|---|
| **Git tag** (`vMAJOR.MINOR.PATCH`) | "which release is this?" - the release identifier | `git tag -a`; shown as `Release` in Settings |
| `package.json` `version` | the product/source version number | root `package.json`; shown as `Version` in Settings |
| Build commit + time | exactly which source was built | injected by `vite.config.ts`; shown in Settings |
| Cloudflare **Version ID** | which *deployment* is live | Cloudflare dashboard / wrangler output - never the product version |

**Current ambiguity (decision needed from the owner, not guessed here):** the only tag is `v0.9.0`
("stable pre-SaaS production baseline", 2026-10-18) but `package.json` still says `1.0.0`. Settings therefore shows a release such as
`v0.9.0-36-g…` next to version `1.0.0`. Pick ONE of: (a) set `package.json` to `0.9.0` and bump it together with each tag
(recommended while pre-SaaS), or (b) declare `1.0.0` and tag `v1.0.0`. Until then, the tag is authoritative for "what was released".
At release time: bump `package.json`, commit, tag that commit, then build - so `Release` and `Version` agree.

## Release checklist

1. `git status` clean on `main`; changes reviewed.
2. `npx tsc --noEmit` and `npm run typecheck:strict`.
3. `npm run lint` (0 errors; the warning count must not grow).
4. `npm test` (frontend + proxies + security/config baseline) and in `worker/`: `npm test` (core, Workers runtime, prod-sim).
5. `npm run audit:prod` (must be clean) and review `npm audit` for dev tooling.
6. `npm run build`, then `npm run bundle:check` (warnings only) and note the sizes.
7. In `worker/`: `npm run validate` (production safety guard; changes nothing).
8. Backup compatibility: the round-trip tests are part of step 4; also restore a previous real backup file into a scratch browser profile.
9. Manual smoke on the built app (`npm run preview`): Dashboard, Command Center, a Daily Report finalize/publish, an export.
10. Update `CHANGELOG.md` (Added / Changed / Fixed / Security) and the version (see above).
11. **Push** (manual, by the owner).
12. **Deploy** (manual, by the owner; see DEPLOYMENT_PLAN.md - frontend build first, then the Worker).
13. Production smoke (the curl checks in DEPLOYMENT_PLAN.md and one sign-in).
14. Tag the released commit and create release notes.

Rollback basics: see [RECOVERY.md](RECOVERY.md).

## Bundle size budget (gzip, warning only)

Baseline recorded 2026-10-25 (`npm run build`): main app chunk 125 kB, locale dictionaries 108 kB, vendor (React) 44 kB, largest lazy
chunk (Test Management) 20 kB. Budgets: main 150, locales 130, vendor 60, any lazy chunk 40. `npm run bundle:check` prints
anything over; it never fails the build. The locale bundle grows with every string (EN + JA), so watch it first.

## Supported browsers

Developed and manually smoke-tested on current **Chrome / Edge** (Chromium). The app uses IndexedDB, ES modules, `Intl` time zones
and the Clipboard API (with a visible fallback). Safari and Firefox are **not** tested; no compatibility is claimed for them.
