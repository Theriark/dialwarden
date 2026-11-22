# Dialwarden: one image, Free and Paid plans (docs/ci-cd.md).
#
# Build stage: installs the workspace from the lock file, builds it, writes
# THIRD_PARTY_NOTICES and deploys only the server's production files to /out,
# with the web build in /out/public.
# Runtime stage: node:24-slim with /out, run as UID 10001. Nothing from tools/
# reaches the runtime stage. Both FROM lines carry the same digest; Dependabot
# (docker) updates them together.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
WORKDIR /src
# pnpm is the exact version pinned in package.json "packageManager".
RUN corepack enable
COPY . .
RUN --mount=type=cache,id=dialwarden-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# pnpm deploy derives /out/pnpm-lock.yaml from pnpm-lock.yaml and installs it
# frozen, so the image ships exactly the versions CI tested and audited. Without
# a shared lock file pnpm falls back to a fresh resolution and writes no lock
# file: the test -f refuses that. The derived file is removed afterwards (it
# lists the whole workspace and would add dev packages to the image scan).
# The web build goes to /out/public, which the server serves from /app/public
# (contract C8); a build without index.html fails here.
RUN --mount=type=cache,id=dialwarden-pnpm-store,target=/pnpm/store \
    pnpm run build \
 && pnpm run notices \
 && pnpm --filter @dialwarden/server deploy --prod /out \
 && test -f /out/pnpm-lock.yaml \
 && rm /out/pnpm-lock.yaml \
 && cp -r apps/web/dist /out/public \
 && test -f /out/public/index.html \
 && cp LICENSE LICENSING.md THIRD_PARTY_NOTICES /out/

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
# The commit, its commit time and the feature baseline (feature_baseline.sh).
# They go into /app/build-info.json (below), the only place the server reads
# them in production, so no environment variable can move the dates the
# licence rule compares. They never change on promotion: Stage and Production
# run this same digest. A build without both dates fails here.
ARG REVISION=unknown
ARG SOURCE_DATE_EPOCH
ARG FEATURE_BASELINE_EPOCH
ENV NODE_ENV=production
RUN test -n "${SOURCE_DATE_EPOCH}" && test -n "${FEATURE_BASELINE_EPOCH}" \
 || { echo "SOURCE_DATE_EPOCH and FEATURE_BASELINE_EPOCH are required" >&2; exit 1; }
# The app needs neither npm, corepack nor yarn at run time: remove them, and
# create the two volume folders of deploy/dokploy.json for UID 10001 (a new
# named volume copies their owner). Everything else stays owned by root, so the
# app can write only to /data, /demo-servers and /tmp.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data /demo-servers \
 && chown 10001:10001 /data /demo-servers \
 && chmod 0750 /data /demo-servers
WORKDIR /app
# /app/public (the web build) is owned by root like the rest of /app.
COPY --from=build /out/ /app/
RUN printf '{"revision":"%s","buildEpoch":"%s","featureBaselineEpoch":"%s"}\n' \
      "${REVISION}" "${SOURCE_DATE_EPOCH}" "${FEATURE_BASELINE_EPOCH}" \
      > /app/build-info.json \
 && chmod 0444 /app/build-info.json
USER 10001:10001
VOLUME ["/data", "/demo-servers"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
