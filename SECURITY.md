# Security policy

Dialwarden stores SSH keys, SFTP and RCON passwords for game servers, so we treat
security reports with priority.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting on this repository
(Security tab, "Report a vulnerability"). Do not open a public issue.

Include the version (or image digest), what you did, what happened and, if you can,
a minimal way to reproduce it. We confirm receipt and keep you informed until it is
fixed.

## Supported versions

Dialwarden is not released yet. The support period for released versions will be
stated here with the first release (27.0.0).

## First run and the setup token

Until the owner account exists, account creation and backup import on a fresh
instance need the one-time setup token from the container log or the file
`setup-token` in the data folder, so nobody else who reaches the instance can
claim it. Keep the log private until setup is done. `DEV_SEED_OWNER_EMAIL` and
`DEV_SEED_OWNER_PASSWORD` create the owner at first start for unattended test
setups; do not leave them set on a production instance.

## Verifying images

Every image is signed with cosign keyless signing from this repository's CI. See
docs/ci-cd.md for the verify command.
