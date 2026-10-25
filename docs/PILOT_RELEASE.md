# Pilot release baseline

The pilot is the first sustained real-world use of GanttChart by a QA Supervisor and a Delivery QA team. It is a **stability and
learning** phase, not a feature phase: only fixes, support improvements and documentation go in.

## The baseline rule

| What | Rule |
|---|---|
| Release channel | `pilot` - shown in Settings -> Support & Pilot and in the diagnostics text. It is context for support, not a warning. |
| Branching | **No permanent pilot branch.** `main` plus an annotated tag per pilot release. A branch is added only if a fix must ship while `main` holds unreleased work. |
| Source version | One number, in `package.json`. **Owner decision still required** (see below); this baseline does not pick one. |
| Tag | `v<source-version>-pilot.<n>` (annotated, on the released commit). `n` counts pilot releases of that source version, starting at 1. |
| Deployment reference | The Cloudflare **Version ID** printed by the deploy, written in the release notes next to the tag. It identifies a deployment, never the product. |
| Release notes | One record per pilot release, from the template below, kept in `CHANGELOG.md` (summary) and in the GitHub release (full). |

### Version authority - decision needed from the owner

The only existing tag is `v0.9.0` (2026-10-18, "stable pre-SaaS production baseline") while `package.json` says `1.0.0`. Until the owner
chooses, **no pilot tag is created and this repository does not choose for them.** The two sensible options:

1. **Source version `0.9.x`** - set `package.json` to `0.9.0` (matching the existing tag), then pilot tags are `v` + that number + `-pilot.1`, `-pilot.2`, ... and the next
   product release is a patch/minor bump. Keeps `1.0.0` for the first paid release.
2. **Source version `1.0.0`** - keep `package.json`, retire the meaning of `v0.9.0`, and use `-pilot.1`, `-pilot.2`, ... tags on that number

Whichever is chosen, bump `package.json` first, commit, then tag that commit, then build, so Settings shows the same version in
`Version` and `Release`.

## Release metadata

`Version`, `Release` (git describe), `Commit`, `Build time` and `Channel` are baked into the bundle at build time
(`vite.config.ts` -> `src/lib/buildInfo.ts`) and shown in Settings and the diagnostics text. No file path or machine name is included.
Set `RELEASE_CHANNEL` at build time only when another channel exists.

## Tagging commands (do not run until the version decision is made)

```bash
# 1. on main, clean tree, all checks green; package.json already at the chosen source version
git tag -a vX.Y.Z-pilot.N -m "Pilot release N of vX.Y.Z: <one-line summary>"
git push origin vX.Y.Z-pilot.N        # manual, by the owner
```

Replace `X.Y.Z` / `N` with the decided values. Never move or delete a pushed tag; fix forward with `pilot.N+1`.

## Roll forward first

For a small production issue: **fix forward** - fix on `main`, run the checks, redeploy, run the smoke checklist, tag the next pilot release.
Use **rollback** (see [PILOT_OPERATIONS.md](PILOT_OPERATIONS.md)) only for a severe regression: data at risk, nobody can sign in, a core screen unusable.

## Pilot release notes template

```
Pilot Release
Version:                 (source version)
Tag:                     vX.Y.Z-pilot.N
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
