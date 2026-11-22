# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| enshrouded-like.json | a strict JSON server file shaped like Enshrouded's: nested objects, an array of groups, large integers, a float, booleans, a \/ escape and a non-ASCII character |
| crlf-bom.json | CRLF line endings, a BOM, tab indentation, a one-line object, non-ASCII text and trailing spaces |
| jsonc-comments.json | comments and trailing commas: accepted by the jsonc adapter, errors for the strict json adapter |
| malformed-trailing-comma.json | malformed for strict JSON: a trailing comma before } |
| minified.json | one-line JSON without a final line break |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
