#!/usr/bin/env bash
# Feature baseline of a build (dev-work-plan P0 step 6, the CRA-safe licence rule
# of P1). The feature line is "line" in packages/entitlement/feature-line.json,
# for example 27.0. The baseline is the commit time of the feature release tag
# v<line>.0 (v27.0.0) when that tag exists, so a security-only patch build of the
# line keeps the baseline of its feature release; otherwise it is the build's own
# SOURCE_DATE_EPOCH (no release of the line yet).
#
#   SOURCE_DATE_EPOCH=<commit epoch> feature_baseline.sh
#
# Prints the baseline as Unix seconds. The caller fetches the tags first
# (actions/checkout with fetch-depth 0).
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ "${SOURCE_DATE_EPOCH:-}" =~ ^[0-9]+$ ]] || fail "SOURCE_DATE_EPOCH must be Unix seconds, got '${SOURCE_DATE_EPOCH:-}'"
file="packages/entitlement/feature-line.json"
[[ -f "${file}" ]] || fail "${file} is missing"
line="$(jq -r '.line // empty' "${file}")"
[[ "${line}" =~ ^27\.(0|[1-9][0-9]*)$ ]] || fail "${file}: line must be 27.<minor>, got '${line}'"

tag="v${line}.0"
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  baseline="$(git log -1 --format=%ct "refs/tags/${tag}^{commit}")"
  [[ "${baseline}" =~ ^[0-9]+$ ]] || fail "cannot read the commit time of ${tag}"
  echo "feature baseline: commit time of ${tag}" >&2
else
  baseline="${SOURCE_DATE_EPOCH}"
  echo "feature baseline: ${tag} does not exist yet, using SOURCE_DATE_EPOCH" >&2
fi
echo "${baseline}"
