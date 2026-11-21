# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests. None
is a copy of a game publisher's default file; each reproduces only a format, its
keys and its known quirks (legal-input-1, section 2).

| File | What it reproduces |
| --- | --- |
| sample.ini | a minimal INI file: a section, keys, an empty value and comments |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
