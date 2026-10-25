# Releasing

Releases are **manual**: this repository does not automate pushing or deploying. This page is the checklist, the version rules,
the bundle budget and the supported-browser assumptions.

## Version authority

| Identifier | Rule | Where it shows |
|---|---|---|
| **`package.json` `version`** | The **canonical product/source version**. Changed only by a deliberate release commit. | Settings -> `Version`; diagnostics |
| **Git tag** | For a formal release the tag is **`v` + the package version, exactly**. | Settings -> `Release` (git describe) |
| **Git commit** | The exact source identity. | Settings -> `Commit` |
| **Cloudflare Version ID** | **Deployment identity only** - which deployment is live. Never the product version. | Cloudflare dashboard / deploy output; written in the release notes |
| **Build timestamp** | The build identity. | Settings -> `Build` |

The root `package.json` is the only product version. `worker/package.json` (`0.1.0`) is a private tooling package and is deliberately **not** the
product version; the proxies have no package. The historical tag `v0.9.0` stays as it is (the pre-pilot production baseline); it is never
moved, rewritten or deleted.

**First pilot version: `0.10.0-pilot.1`** (tag `v0.10.0-pilot.1`, created later by the owner). Each further pilot release changes the
package version first - `0.10.0-pilot.2`, `0.10.0-pilot.3`, ... - and the tag follows. A later non-pilot release simply drops the suffix
(for example `0.10.0`). Release channel stays `pilot` for these builds.

Release order: bump `package.json` (and the lockfile's own version) in the release commit, run the checks, tag **that** commit as `v<version>`,
then build - so `Version` and `Release` agree in Settings.

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
10. Update `CHANGELOG.md` (Added / Changed / Fixed / Security) and the package version (see Version authority).
11. **Push** (manual, by the owner).
12. **Deploy** (manual, by the owner; see DEPLOYMENT_PLAN.md - frontend build first, then the Worker).
13. **Production smoke** - the full checklist in [PRODUCTION_SMOKE.md](PRODUCTION_SMOKE.md) (login, sync, screens, integrations, report, publishing, analytics, backup export).
14. Tag the released commit as `v<package version>` (pilot builds, e.g. `v0.10.0-pilot.1`; see [PILOT_RELEASE.md](PILOT_RELEASE.md)) and write the **pilot release notes** from its template.
15. Post-release monitoring checklist for the first day ([PILOT_OPERATIONS.md](PILOT_OPERATIONS.md)).

Flow: release checklist -> push -> deploy -> production smoke -> tag -> pilot notes -> monitoring. Prefer **fixing forward** for small issues; roll back only for severe regressions.

Rollback basics: see [RECOVERY.md](RECOVERY.md).

## Bundle size budget (gzip, warning only)

Baseline recorded 2026-10-25 (`npm run build`): main app chunk 125 kB, locale dictionaries 108 kB, vendor (React) 44 kB, largest lazy
chunk (Test Management) 20 kB. Budgets: main 150, locales 130, vendor 60, any lazy chunk 40. `npm run bundle:check` prints
anything over; it never fails the build. The locale bundle grows with every string (EN + JA), so watch it first.

## Supported browsers

Developed and manually smoke-tested on current **Chrome / Edge** (Chromium). The app uses IndexedDB, ES modules, `Intl` time zones
and the Clipboard API (with a visible fallback). Safari and Firefox are **not** tested; no compatibility is claimed for them.
