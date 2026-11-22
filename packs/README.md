# Game packs

One folder per game, named by its pack id (lower case, digits and dashes), with
a `pack.json` that follows contract C3. The JSON Schema is
`packages/packs-schema/src/pack.schema.json`; the synthetic pack in
`packages/packs-schema/test/packs/testpack` shows every part of it. The server
loads every pack at start and refuses a broken one with a log line.

Rules for every pack (dev-work-plan, Rules for every phase):

- Every description and label is written in our own words. Wikis and docs are
  used only to check facts; `sources[]` records the URLs.
- Game names in plain text only; no game or Steam logos, art or screenshots.
- A `fixtures/` folder holds only synthetic files written by Theriark and a
  `SYNTHETIC.md` that lists them. The CI hygiene job fails without it.

## pnpm packs:check

`pnpm packs:check` runs inside `pnpm test` and fails a pack when:

- `pack.json` breaks the schema (descriptions 20 to 300 characters, `sources[]`
  present, plain-text names) or a reference check (duplicate keys, a rule or
  preset that names a setting the pack does not have, a JSONLogic operator
  outside the allow-list, a locator kind that does not fit the file's adapter);
- a file has no fixture: the fixture of a file is `fixtures/` plus the last part
  of the file's first path (for example `fixtures/PalWorldSettings.ini`);
- a setting's locator does not resolve on its fixture, or its default differs
  from the value the fixture sets.

Settings of files that use the `launch`, `shellvar` or `shellvar-systemd`
adapter refuse values with shell characters (; & | ` $ ( ) < > \ and line
breaks), because LinuxGSM passes start parameters to a shell.
