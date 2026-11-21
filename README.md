# Dialwarden

Self-hosted settings editor for dedicated game servers installed with SteamCMD.
Dialwarden reads a server's config files and launch parameters, shows them as
typed, described settings, and writes back only the values you change, so hand
edits, comments and unknown keys are kept. Every save is snapshotted; rollback is
one click.

One Docker image with two plans:

- **Free**: up to 3 servers, local folder and SFTP connectors, all supported games,
  typed and raw editor, diff, lint, history of the last 5 versions, 3 presets, the
  apply step (stop, start, restart hooks), two-factor sign-in, app backup.
- **Paid**: unlocked by an offline licence key in the same image. More servers,
  users and roles, audit log, OIDC sign-in, full history, unlimited and bulk
  presets, scheduled changes with automatic revert, drift alerts, comparison matrix
  and change reports.

The key is checked inside the image, offline, with no account and no phone-home.
When a licence ends nothing is deleted and game servers are never touched.

## Status

In development. The first release will be `27.0.0`. Run instructions, the Docker
Compose file and the documentation arrive with the application.

## Licence

Source available under the [Fair Core License, Version 1.0, MIT Future License](LICENSE)
(FCL-1.0-MIT). Each version becomes MIT two years after its release. The licence
forbids moving, changing, disabling or circumventing the licence key functionality;
[LICENSING.md](LICENSING.md) says which code that is. Third-party licences:
[docs/licences.md](docs/licences.md).

## Development

- CI/CD and the release process: [docs/ci-cd.md](docs/ci-cd.md)
- Contributing (DCO sign-off): [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

Dialwarden is not affiliated with or endorsed by Valve or any game publisher. Game
names are used only to say which games it works with; they belong to their owners.
