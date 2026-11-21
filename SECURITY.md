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

## Verifying images

Every image is signed with cosign keyless signing from this repository's CI. See
docs/ci-cd.md for the verify command.
