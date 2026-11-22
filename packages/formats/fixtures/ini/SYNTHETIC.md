# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| plain.ini | key=value with spaces around =, ; and # comment lines, a ; inside a value, a quoted value with padding, an empty value, a Windows path and trailing spaces |
| crlf-bom.ini | CRLF line endings, a UTF-8 BOM, a non-ASCII value and trailing spaces |
| duplicates.ini | a key outside any section, a duplicate key and a repeated section |
| malformed-section.ini | malformed: a section header without ] |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
