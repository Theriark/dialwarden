# Game packs

One folder per game, named by its pack id (lower case, digits and dashes), with
a `pack.json` that follows contract C3. The JSON Schema is
`packages/packs-schema/src/pack.schema.json`; the synthetic pack in
`packages/packs-schema/test/packs/testpack` shows every part of it. The server
loads every pack at start and refuses a broken one with a log line.

| Pack       | Files                                                                 | Settings |
| ---------- | --------------------------------------------------------------------- | -------- |
| 7dtd       | serverconfig.xml, raw-only serveradmin.xml, app-managed launch line   | 101      |
| ark-sa     | GameUserSettings.ini and Game.ini (Unreal INI), app-managed launch line | 135     |
| enshrouded | enshrouded_server.json                                                | 61      |
| palworld   | PalWorldSettings.ini (OptionSettings struct), app-managed launch line | 130      |
| pzomboid   | server ini, SandboxVars.lua, app-managed launch line                  | 147      |
| rust       | server.cfg and users.cfg (console convars), app-managed launch line  | 59       |
| valheim    | app-managed launch line                                               | 24       |

Rules for every pack (dev-work-plan, Rules for every phase):

- Every description and label is written in our own words. Wikis and docs are
  used only to check facts; `sources[]` records the URLs.
- Game names in plain text only; no game or Steam logos, art or screenshots.
- A `fixtures/` folder holds only synthetic files written by Theriark and a
  `SYNTHETIC.md` that lists them. The CI hygiene job fails without it.

## Detection warnings

A path in `detection.warnings` may have one part that is exactly `*`. It stands
for any single folder entry, such as the world id folder of a Palworld save
(`Pal/Saved/SaveGames/0/*/WorldOption.sav`). The detection probe lists that
folder (at most 64 entries); a probe that cannot list folders never matches
such a path, and a path with two `*` parts never matches. Markers stay plain
paths.

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

## Pack tests

- `contract.test.ts`: every setting of every listed pack round-trips through its
  format adapter on the synthetic fixture (another valid value is written and
  read back, no other setting of the file moves, and writing the fixture value
  back gives the fixture's bytes again). Two adapters cannot always restore the
  old bytes by design, so for those settings the test checks only the value: a
  removed bare launch flag is added again at the end of the line (the four bare
  Palworld flags), and a JSON list is written in JSON.stringify layout (the
  Enshrouded tags).
- `GAME/GAME.test.ts`: the pack's own rules fire and clear, its presets apply,
  and its launch flags (if any) refuse shell characters.
- `kit.ts` holds the shared helpers. It is a file, not a folder, because every
  folder here is a pack; the image gets only `pack.json` files and fixtures.
