# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| linuxgsm.cfg | a LinuxGSM-style cfg: double and single quotes, ${var} references kept as text, export, a comment after a value, trailing spaces and a duplicate that wins |
| sample.env | a .env file: a backslash escape, escaped quotes and $ inside double quotes, an empty value and a single-quoted literal |
| environmentfile.conf | a systemd EnvironmentFile: an unquoted value with spaces, double and single quotes, a ; comment and an indented line with spaces around = |
| malformed-unclosed-quote.cfg | malformed: a double quote that is not closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
