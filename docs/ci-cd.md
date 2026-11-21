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

`STRICT` in `ci.yml` is `true` since phase P0 added the application: every job
must run and succeed, and a skipped job fails the gate. (`false` was the setup
mode before the application existed: a check without input was skipped, never
passed, and a tripwire failed the run as soon as an application file existed.)

| Job | Checks |
| --- | --- |
| detect | which inputs exist; STRICT value; tripwire |
| 1 - lint, typecheck, unit tests and build | `pnpm install --frozen-lockfile`, then `pnpm run lint` (eslint with security rules, no warnings; prettier), `typecheck`, `test` (vitest), `build` (ends with `check:assets`: no outside host in CSS `url()` or `@import`, no outside font host) |
| 2 - dependency audit and licence audit | `pnpm audit --prod --audit-level moderate`, `pnpm run licence:audit` |
| 3 - hygiene | LICENSE is FCL-1.0-MIT; no edition names; no private key block; no OSS claim in README.md, LICENSING.md, docs/ or apps/web/src (the exact phrase "not open source" is the one allowed use); every `packs/*/fixtures` and `packages/formats/fixtures` folder has a SYNTHETIC.md that lists each file; gitleaks on the tree and on every commit of the range |
| 4 - multi-arch image build | amd64 and arm64 with SOURCE_DATE_EPOCH and FEATURE_BASELINE_EPOCH; image user 10001:10001 and process UID 10001; base image Node 24; no tools/ in the image; read-only root file system with /tmp as tmpfs; `/healthz` answers 200 with the commit as `revision`, the commit time as `buildDate`, the feature baseline as `featureBaseline` and the package version; `/readyz` answers 200 |
| SBOM | syft SPDX SBOM of the image and grype scan (fails on a fixable high or critical) |
| DCO | Signed-off-by on every commit (`.github/scripts/dco.sh`) |
| Merge gate summary | the only required result; fails on any failure, and on any skip when STRICT is true |

The root `package.json` provides the scripts `lint`, `typecheck`, `test`,
`build`, `check:assets`, `notices` and `licence:audit`, the `packageManager`
field (pnpm 10, exact version, through corepack) and
`pnpm.onlyBuiltDependencies` (argon2, better-sqlite3).

`pnpm-lock.yaml` is resolved by the lock job (`ci.yml` with `mode=lock`, run on
the feature branch) and committed by it; nobody edits it by hand.

## Workspace

| Path | What it is |
| --- | --- |
| `apps/server` | Fastify server on port 8080. P0: health stub (`/healthz`, `/readyz`); P1 replaces it with the server core |
| `apps/web` | Vite web app, built to `apps/web/dist`; P1-B builds the shell |
| `packages/entitlement` | Licence key functionality (LICENSING.md): build information now, licence rule and feature registry from P1; `feature-line.json` |
| `packages/formats` | Format engine (contract C2), with synthetic fixtures |
| `packages/packs-schema` | Pack schema (contract C3) |
| `packs/` | Game packs, one folder per game with `pack.json` |
| `tools/licence`, `tools/seed`, `tools/notices` | Build and crew tools; never in the image |

Workspace packages resolve to their TypeScript sources for typecheck and tests
(export condition `source`) and to `dist/` at run time; `pnpm -r run build`
builds them in dependency order.

## Image build and the licence build date

The image is built once, on the merge to development, by the job
"Deploy Development (build once, deploy the digest)":

- `SOURCE_DATE_EPOCH` is the commit time of the built commit (`git log -1 --format=%ct`),
  passed as a build argument and with `rewrite-timestamp=true`, so layer and config
  timestamps come from the commit and the build is repeatable.
- The Dockerfile turns the build arguments `REVISION`, `SOURCE_DATE_EPOCH` and
  `FEATURE_BASELINE_EPOCH` into `DIALWARDEN_REVISION`, `DIALWARDEN_BUILD_EPOCH`
  and `DIALWARDEN_FEATURE_BASELINE_EPOCH`, which the entitlement module reads and
  `/healthz` reports as `revision`, `buildDate` and `featureBaseline`. Paid is
  active when the licence signature is valid, the licence is not revoked and the
  build is covered by the licence `updatesUntil` (rnd-report-1 3.3, with the
  CRA-safe baseline rule of P1). Stage and Production run the same digest, so
  these values never change on promotion.
- Feature baseline: `packages/entitlement/feature-line.json` names the feature
  line (`27.0`). `.github/scripts/feature_baseline.sh` prints the commit time of
  the tag `v<line>.0` (`v27.0.0`) when it exists, otherwise `SOURCE_DATE_EPOCH`.
  CI passes it to every image build (docker-build, SBOM, Development). Promote -
  Stage (`release_tags.sh next`, also in a dry run) refuses a candidate whose
  major.minor differs from the feature line of the promoted commit, so a new
  feature version starts with a change to `feature-line.json`.
- Labels: `org.opencontainers.image.source`, `revision`, `created` (the commit time)
  and `licenses=LicenseRef-FCL-1.0-MIT`.
- The image: `node:24-slim` pinned by digest (both stages, Dependabot keeps it
  current); `pnpm deploy --prod` of `@dialwarden/server` only, so nothing from
  `tools/` is in it; npm, corepack and yarn removed; `USER 10001:10001`;
  `VOLUME /data`; `EXPOSE 8080`; `HEALTHCHECK` with node `fetch` on `/healthz`.
  Application files belong to root, so the app writes only to `/data` and
  `/tmp`. `LICENSE`, `LICENSING.md` and `THIRD_PARTY_NOTICES` are in `/app`.
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
  does not list it (the broker refuses unknown kinds); P1-C adds
  `DIALWARDEN_LICENCE`.
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
| DEMO_SEED | literal `true` on Development and Stage (renamed from DEV_SEED_DEMO in P0, so Stage has demo servers for the QA cards) |
| TRUSTED_PROXIES | literal `172.31.1.0/24,172.17.0.1` (Dokploy network and the tunnel hop; never a wildcard) |
| LOG_LEVEL | literal `info` |

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
