# Dialwarden: one image, Free and Paid plans (docs/ci-cd.md).
#
# Build stage: installs the workspace from the lock file, builds it, writes
# THIRD_PARTY_NOTICES and deploys only the server's production files to /out.
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
RUN pnpm run build \
 && pnpm run notices \
 && pnpm --filter @dialwarden/server deploy --prod --legacy /out \
 && cp LICENSE LICENSING.md THIRD_PARTY_NOTICES /out/

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
# The commit, its commit time and the feature baseline (feature_baseline.sh),
# read by packages/entitlement. They never change on promotion: Stage and
# Production run this same digest.
ARG REVISION=unknown
ARG SOURCE_DATE_EPOCH
ARG FEATURE_BASELINE_EPOCH
ENV NODE_ENV=production \
    DIALWARDEN_REVISION=${REVISION} \
    DIALWARDEN_BUILD_EPOCH=${SOURCE_DATE_EPOCH} \
    DIALWARDEN_FEATURE_BASELINE_EPOCH=${FEATURE_BASELINE_EPOCH}
# The app needs neither npm, corepack nor yarn at run time: remove them, and
# create /data for UID 10001. Everything else stays owned by root, so the app
# can write only to /data and /tmp.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /data \
 && chown 10001:10001 /data \
 && chmod 0750 /data
WORKDIR /app
COPY --from=build /out/ /app/
USER 10001:10001
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
