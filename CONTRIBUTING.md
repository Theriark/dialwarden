# Contributing to Dialwarden

Thank you for helping. Game packs (the per-game settings descriptions in `packs/`)
are the most useful contribution.

## Licence of contributions

Dialwarden is source available under FCL-1.0-MIT (see LICENSE). By sending a
contribution you agree that it is licensed under the same terms and that Theriark
may relicense it as part of Dialwarden. The exact contributor licence grant wording
is pending Legal review and will replace this paragraph before the first release.

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by:` line (Developer Certificate of Origin
1.1, https://developercertificate.org/). Use `git commit -s`. CI checks every commit
of a pull request.

If you forgot the sign-off on an earlier commit, a later signed commit of yours can
add it with this line in its message:

```
I, Your Name <you@example.com>, hereby add my Signed-off-by to this commit: <full sha>
```

## Pull requests

- Branch from `development`, open the pull request into `development`.
- Keep one topic per pull request. Describe the Free and Paid behaviour you checked.
- A maintainer starts CI with the `ci-go` label. CI must be green and another person
  must review before merge.
- Never commit credentials, private keys or real server passwords. Test fixtures use
  obvious placeholders.
