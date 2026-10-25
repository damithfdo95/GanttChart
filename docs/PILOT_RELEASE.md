# Pilot release baseline

The pilot is the first sustained real-world use of GanttChart by a QA Supervisor and a Delivery QA team. It is a **stability and
learning** phase, not a feature phase: only fixes, support improvements and documentation go in.

## The baseline rule

| What | Rule |
|---|---|
| Release channel | `pilot` - shown in Settings -> Support & Pilot and in the diagnostics text. It is context for support, not a warning. |
| Branching | **No permanent pilot branch.** `main` plus an annotated tag per pilot release. A branch is added only if a fix must ship while `main` holds unreleased work. |
| Source version | One number, in `package.json`: the canonical product version. The first pilot is `0.10.0-pilot.1`. |
| Tag | `v` + the package version, exactly (annotated, on the released commit): `v0.10.0-pilot.1` for the first pilot. |
| Deployment reference | The Cloudflare **Version ID** printed by the deploy, written in the release notes next to the tag. It identifies a deployment, never the product. |
| Release notes | One record per pilot release, from the template below, kept in `CHANGELOG.md` (summary) and in the GitHub release (full). |

### Version authority

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

## Release metadata

`Version`, `Release` (git describe), `Commit`, `Build time` and `Channel` are baked into the bundle at build time
(`vite.config.ts` -> `src/lib/buildInfo.ts`) and shown in Settings and the diagnostics text. No file path or machine name is included.
Set `RELEASE_CHANNEL` at build time only when another channel exists.

## Tagging commands (run by the owner when releasing; this repository does not create tags)

```bash
# On main, clean tree, all checks green, package.json already at the release version
git tag -a v0.10.0-pilot.1 -m "Pilot release 1: <one-line summary>"
git push origin v0.10.0-pilot.1        # manual, by the owner
```

For a later pilot release use its own version (`v0.10.0-pilot.2`, ...). Never move or delete a pushed tag; fix forward with the next number.

## Roll forward first

For a small production issue: **fix forward** - fix on `main`, run the checks, redeploy, run the smoke checklist, tag the next pilot release.
Use **rollback** (see [PILOT_OPERATIONS.md](PILOT_OPERATIONS.md)) only for a severe regression: data at risk, nobody can sign in, a core screen unusable.

## Pilot release notes template

```
Pilot Release
Version:                 (package.json version)
Tag:                     v + that version
Commit:
Deployed (Version ID):
Date:

Added:
Changed:
Fixed:
Known limitations:       (link: Settings -> Support & Pilot -> Known Limitations)
Smoke test:              (docs/PRODUCTION_SMOKE.md - result, who, when)
Rollback:                (previous Version ID / tag)
Feedback received since the last pilot release:
```

## Release flow

`release checklist (docs/RELEASING.md)` -> **push** -> **deploy** -> `production smoke (docs/PRODUCTION_SMOKE.md)` -> **tag** -> **pilot notes** ->
`post-release monitoring (docs/PILOT_OPERATIONS.md)`. Each arrow is manual and done by the owner.

## Monitoring and telemetry (deliberately not built)

There is no automatic monitoring, alerting or product telemetry, and none is added in the pilot: success is measured with the pilot diary
([PILOT_SUCCESS_CRITERIA.md](PILOT_SUCCESS_CRITERIA.md)) and feedback reports ([PILOT_FEEDBACK.md](PILOT_FEEDBACK.md)). Later SaaS needs: error
aggregation, uptime checks, alerting, integration-health checks and audit export (see [SAAS_READINESS.md](SAAS_READINESS.md)).
