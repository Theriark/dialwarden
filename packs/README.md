# Game packs

One folder per game, named by its pack id (lower case, digits and dashes), with
a `pack.json` that follows contract C3 (`packages/packs-schema`). The first packs
(Palworld, Enshrouded) arrive in P3.

Rules for every pack (dev-work-plan, Rules for every phase):

- Every description and label is written in our own words. Wikis and docs are
  used only to check facts; `sources[]` records the URLs.
- Game names in plain text only; no game or Steam logos, art or screenshots.
- A `fixtures/` folder holds only synthetic files written by Theriark and a
  `SYNTHETIC.md` that lists them. The CI hygiene job fails without it.
