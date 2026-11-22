# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| server.cfg | console commands: quoted and bare values, an empty value, a // comment after a value, dotted Rust names, two commands on one line, a duplicate in another case and trailing spaces |
| crlf-bom.cfg | CRLF line endings, a BOM and a non-ASCII value |
| malformed-unclosed-quote.cfg | malformed: a quote that is not closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
