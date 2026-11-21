#!/usr/bin/env bash
# DCO check of the CI job "DCO - Signed-off-by on every commit" (CONTRIBUTING.md,
# DCO 1.1). Kept here, not inline in ci.yml, so a test can run it against real
# commits.
#
# Which commits: a pull request, every commit in it. A push to development, the new
# commits, except the merge or squash commits GitHub writes from an already checked
# pull request. Anything else: the commits since the merge base with development.
#
# Exempt without a sign-off, because their author cannot sign off:
# - a lock job commit of github-actions[bot]: its exact message, only pnpm-lock.yaml;
# - a genuine Dependabot commit: Dependabot's author address with GitHub as the
#   committer, a signature GitHub reports as verified, a "Bump " or "bump " subject
#   (after an optional conventional prefix such as "chore(deps): ") and only
#   dependency manifests; on a pull request, Dependabot also opened it.
# A later signed commit of the same author can sign off an earlier unsigned one
# (retroactive sign-off, CONTRIBUTING.md).
#
# Environment: EVENT, PR_BASE, PR_HEAD, PR_AUTHOR, PUSH_BEFORE, HEAD_SHA,
# REPOSITORY and GH_TOKEN (read-only, for the signature lookup of `gh api`).
set -euo pipefail

bot="41898282+github-actions[bot]@users.noreply.github.com"
dependabot="49699333+dependabot[bot]@users.noreply.github.com"
exempt_github_merges=false
dependabot_allowed=false
case "${EVENT}" in
  pull_request)
    range="${PR_BASE}..${PR_HEAD}"
    [[ "${PR_AUTHOR:-}" == "dependabot[bot]" ]] && dependabot_allowed=true
    ;;
  push)
    exempt_github_merges=true
    dependabot_allowed=true
    if [[ "${PUSH_BEFORE}" =~ ^0+$ ]]; then
      range="${HEAD_SHA}^!"
    else
      range="${PUSH_BEFORE}..${HEAD_SHA}"
    fi
    ;;
  *)
    range="$(git merge-base origin/development HEAD)..HEAD"
    ;;
esac
sign_off='^Signed-off-by: [^<>]+ <[^<>@[:space:]]+@[^<>@[:space:]]+>[[:space:]]*$'
retroactive='^I, [^<>]+ <([^<>@[:space:]]+@[^<>@[:space:]]+)>, hereby add my Signed-off-by to this commit: ([0-9a-f]{40})[[:space:]]*$'
# Dependabot's subject, with the conventional prefix it copies from the history.
bump_subject='^([a-z]+(\([a-z0-9._/-]+\))?: )?[Bb]ump '
# The files .github/dependabot.yml lets Dependabot change.
dependabot_files='\.github/workflows/[^/]+\.yml|\.github/actions/[^/]+/action\.yml|Dockerfile|docker-compose\.yml|package\.json|pnpm-lock\.yaml|(apps|packages|tools)/[^/]+/package\.json'

# Author fields can be forged, so GitHub must confirm it wrote and signed the commit.
genuine_dependabot() {
  local sha="$1" subject files verified
  [[ "${dependabot_allowed}" == "true" ]] || return 1
  [[ "$(git show -s --format=%ae "${sha}")" == "${dependabot}" ]] || return 1
  [[ "$(git show -s --format=%ce "${sha}")" == "noreply@github.com" ]] || return 1
  subject="$(git show -s --format=%s "${sha}")"
  [[ "${subject}" =~ ${bump_subject} ]] || return 1
  files="$(git show --format= --name-only "${sha}")"
  [[ -n "${files}" ]] || return 1
  ! grep -qvxE "${dependabot_files}" <<<"${files}" || return 1
  verified="$(gh api "repos/${REPOSITORY}/commits/${sha}" \
    --jq '[.commit.verification.verified, .commit.verification.reason] | @tsv')" || return 1
  [[ "${verified}" == $'true\tvalid' ]]
}

commits="$(git rev-list --no-merges "${range}")"
# Retroactive sign-offs: only from commits that are signed off themselves, and only
# for commits of the same author ("author-email sha" per line).
remediated=""
while read -r sha; do
  [[ -n "${sha}" ]] || continue
  body="$(git show -s --format=%B "${sha}")"
  grep -qE "${sign_off}" <<<"${body}" || continue
  author="$(git show -s --format=%ae "${sha}")"
  while IFS= read -r line; do
    if [[ "${line}" =~ ${retroactive} && "${BASH_REMATCH[1]}" == "${author}" ]]; then
      remediated+="${author} ${BASH_REMATCH[2]}"$'\n'
    fi
  done <<<"${body}"
done <<<"${commits}"
status=0
checked=0
while read -r sha; do
  [[ -n "${sha}" ]] || continue
  author="$(git show -s --format=%ae "${sha}")"
  committer="$(git show -s --format=%ce "${sha}")"
  # A bot commit is only exempt when it is exactly a lock job commit: its message,
  # and only the lock file.
  if [[ "${author}" == "${bot}" ]]; then
    message="$(git show -s --format=%B "${sha}")"
    files="$(git show --format= --name-only "${sha}")"
    if [[ "${message}" == "Update pnpm lock file" && "${files}" == "pnpm-lock.yaml" ]]; then
      echo "exempt ${sha}: lock commit of github-actions[bot]"
      continue
    fi
  fi
  if [[ "${author}" == "${dependabot}" ]] && genuine_dependabot "${sha}"; then
    echo "exempt ${sha}: verified Dependabot commit"
    continue
  fi
  # Push only, relying on the rule that nobody commits to development directly
  # except the initial repository setup (docs/ci-cd.md).
  if [[ "${exempt_github_merges}" == "true" && "${committer}" == "noreply@github.com" ]]; then
    echo "exempt ${sha}: written by GitHub from a checked pull request"
    continue
  fi
  checked=$((checked + 1))
  if git show -s --format=%B "${sha}" | grep -qE "${sign_off}"; then
    echo "signed ${sha}"
  elif grep -qxF "${author} ${sha}" <<<"${remediated}"; then
    echo "signed ${sha} (retroactive sign-off by ${author})"
  else
    echo "::error::commit ${sha} has no Signed-off-by line (git commit -s, see CONTRIBUTING.md)"
    status=1
  fi
done <<<"${commits}"
echo "DCO: ${checked} commit(s) checked in ${range}"
exit "${status}"
