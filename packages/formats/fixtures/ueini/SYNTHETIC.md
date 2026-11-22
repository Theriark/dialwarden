# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| palworld-optionsettings.ini | Palworld one-line OptionSettings struct: nested parentheses, quoted strings with a comma and parentheses inside, empty strings, Title-case booleans, six-decimal floats |
| palworld-crlf-bom.ini | the same struct with CRLF line endings, a UTF-8 BOM, trailing spaces and an escaped quote |
| array-ops.ini | +Key, -Key, .Key and !Key array operations, a duplicate key that differs only in case, a repeated section, a key outside any section and an unknown key |
| malformed-unclosed-struct.ini | malformed: the OptionSettings struct is never closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
