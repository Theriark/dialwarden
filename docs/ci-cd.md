# CI/CD for dialwarden-app

Dialwarden is a single-image product. One repository (`Theriark/dialwarden-app`,
public, FCL-1.0-MIT), one image (`ghcr.io/theriark/dialwarden-app`, linux/amd64 and
linux/arm64), the Free and Paid plans in the same build. Paid is unlocked by an
offline Ed25519-signed licence key verified inside the image. There is no CE/EE
split and no second image.

## Versions

The first release is `27.0.0`. Candidates are annotated tags `v27.0.0-rc.N`, made by
Promote - Stage. No other major or minor number is invented
(`.github/scripts/release_tags.sh`).

## Branches

- `development`: all work enters here through reviewed pull requests from
  `feat/dialwarden-app-the-<n>` branches. The only direct commit is the initial
  repository setup.
- `stage`: moved only by the Gate 2 script (fast-forward to the candidate tag).
- `main`: moved only by the Gate 3 script (merge of stage).

## The three workflows

| Workflow | Started by | What it does |
| --- | --- | --- |
| `ci.yml` (CI) | push to development, label `ci-go` on a pull request, manual (`mode=ci` or `mode=lock`) | Merge gate; on a merge, builds the image once, signs it and deploys the digest to Development |
| `promote-stage.yml` (Promote - Stage) | Gate 2 approval, on development, no inputs | Verifies what Development runs, tests it, tags `v27.x.y-rc.N`, tags the same digest in GHCR, deploys it to Stage |
| `release.yml` (Release) | Gate 3 approval, on development, no inputs | Releases what Stage runs: GHCR `27.x.y` and `latest`, tag `v27.x.y`, GitHub Release with the SBOM |

All three share the concurrency group `dialwarden-app-delivery`: no two delivery
runs overlap and a live deployment is never cancelled. Promote - Stage and Release
also have `dry_run=true`, which checks everything and writes nothing.

## Merge gate (CI)

`STRICT` in `ci.yml` is `false` until phase P0 adds the application and `true`
after. With `false`, a check whose input does not exist is skipped (never a pass)
and a tripwire fails the run as soon as an application file exists.

| Job | Checks |
| --- | --- |
| detect | which inputs exist; STRICT value; tripwire |
| 1 - lint, typecheck, unit tests and build | `pnpm install --frozen-lockfile`, then `pnpm run lint`, `typecheck`, `test`, `build` |
| 2 - dependency audit and licence audit | `pnpm audit --prod --audit-level moderate`, `pnpm run licence:audit` |
| 3 - hygiene | LICENSE is FCL-1.0-MIT; no edition names; no private key block; gitleaks on the tree and on every commit of the range |
| 4 - multi-arch image build | amd64 and arm64 with SOURCE_DATE_EPOCH; image runs as non-root; `/healthz` answers 200 with the commit as `revision` |
| SBOM | syft SPDX SBOM of the image and grype scan (fails on a fixable high or critical) |
| DCO | Signed-off-by on every commit (`.github/scripts/dco.sh`) |
| Merge gate summary | the only required result; fails on any failure, and on any skip when STRICT is true |

P0 provides the root scripts `lint`, `typecheck`, `test`, `build` and
`licence:audit`, the `packageManager` field (pnpm through corepack) and
`pnpm.onlyBuiltDependencies` (argon2, better-sqlite3), then sets STRICT to true.

## Image build and the licence build date

The image is built once, on the merge to development, by the job
"Deploy Development (build once, deploy the digest)":

- `SOURCE_DATE_EPOCH` is the commit time of the built commit (`git log -1 --format=%ct`),
  passed as a build argument and with `rewrite-timestamp=true`, so layer and config
  timestamps come from the commit and the build is repeatable.
- The Dockerfile (P0) turns the `SOURCE_DATE_EPOCH` build argument into the build
  date the entitlement module reads. Paid is active when the licence signature is
  valid, the licence is not revoked and this build date is on or before the licence
  `updatesUntil` (rnd-report-1 3.3). Stage and Production run the same digest, so
  the build date never changes on promotion.
- Labels: `org.opencontainers.image.source`, `revision`, `created` (the commit time)
  and `licenses=LicenseRef-FCL-1.0-MIT`.
- Only the tag `sha-<commit>` is pushed. Promote - Stage adds `27.x.y-rc.N` and
  `stage`; Release adds `27.x.y` and `latest`. Every tag is a carbon copy of the
  same multi-arch index digest.
- The digest is signed with cosign keyless (GitHub OIDC). The signing identity is
  `https://github.com/Theriark/dialwarden-app/.github/workflows/ci.yml@refs/heads/development`;
  Promote - Stage and Release refuse a digest without that signature.
- The SPDX SBOM is attached to the digest as a cosign attestation, kept as a CI
  artefact for 90 days, and attached to the GitHub Release.

Verify an image yourself:

```
cosign verify ghcr.io/theriark/dialwarden-app:27.0.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/Theriark/dialwarden-app/.github/workflows/ci.yml@refs/heads/development
```

## Licence keys

- The production licence key pair is created and held by Ruben, outside the crew.
  It is never generated, stored or used by CI or by any crew tool.
- The development signing key is held by the setup broker. Development receives a
  development licence through the deploy-spec env kind `dev_licence`, signed by the
  broker at prepare time. Until the broker supports that kind, `deploy/dokploy.json`
  does not list it (the broker refuses unknown kinds).
- CI generates throwaway Ed25519 test keys at run time for the licence unit tests.
  No private key block may be committed (hygiene check).

## Runtime (deploy/dokploy.json)

| Setting | Value |
| --- | --- |
| database | none (SQLite in WAL mode on `/data`) |
| volumes | `/data` (database, snapshots, generated secrets), `/demo-servers` (demo game folders, Development) |
| APP_SECRET_KEY | hex64, generated by the broker; encrypts stored secrets |
| SESSION_SECRET | hex64, generated by the broker |
| BASE_URL | `https://<host>` of the environment |
| DEV_SEED_DEMO | `true` on Development only (the broker skips DEV_SEED names on Stage) |

Domains: Development `app-dev-dialwarden.theriark.dev`, Stage
`app-stg-dialwarden.theriark.dev`. Production stays empty until a release is
approved. The Dokploy application ids are filled into `ci.yml`,
`promote-stage.yml` and `release.yml` from the setup broker registration; every
deploying job refuses while they are empty.

## Rollback

Rollback is not a button. Revert on development, let CI deploy the revert to
Development, then promote again. Each deployment records the previous image as the
rollback target, and the deploy action restores it automatically when a deployment
fails. SQLite migrations run forward only at start, after an automatic copy of the
database file; the database is never downgraded. A release that changes the data
format names the last image that can read the old format in its notes.
