# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| sandbox-like.lua | a global assignment shaped like Project Zomboid's SandboxVars: nested tables, -- and --[[ ]] comments, integers, floats, a negative and a hex number, both quote styles, an escaped quote, booleans, nil, a bracket key and a positional list |
| return-table.lua | a return { ... } chunk shaped like a worldgen override: CRLF, a BOM, a one-line nested table, a long-bracket string and trailing spaces |
| malformed-unclosed-table.lua | malformed: a table that is never closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
