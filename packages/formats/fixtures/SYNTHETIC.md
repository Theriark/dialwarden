# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| sample.ini | a minimal INI file: a section, keys, an empty value and comments |
| cfg/SYNTHETIC.md | the list of the cfg fixtures |
| cfg/server.cfg | console commands: quoted and bare values, an empty value, a // comment after a value, dotted Rust names, two commands on one line, a duplicate in another case and trailing spaces |
| cfg/hash-comments.cfg | # comment lines (repeated, empty, indented with spaces or a tab, one holding an unclosed quote, a commented-out command), a # comment after a ;, a # inside a value, a // comment after a command and one real duplicate in another case |
| cfg/crlf-bom.cfg | CRLF line endings, a BOM and a non-ASCII value |
| cfg/malformed-unclosed-quote.cfg | malformed: a quote that is not closed |
| ini/SYNTHETIC.md | the list of the ini fixtures |
| ini/plain.ini | key=value with spaces around =, ; and # comment lines, a ; inside a value, a quoted value with padding, an empty value, a Windows path and trailing spaces |
| ini/crlf-bom.ini | CRLF line endings, a UTF-8 BOM, a non-ASCII value and trailing spaces |
| ini/duplicates.ini | a key outside any section, a duplicate key and a repeated section |
| ini/malformed-section.ini | malformed: a section header without ] |
| json/SYNTHETIC.md | the list of the json fixtures |
| json/enshrouded-like.json | a strict JSON server file shaped like Enshrouded's: nested objects, an array of groups, large integers, a float, booleans, a \/ escape and a non-ASCII character |
| json/crlf-bom.json | CRLF line endings, a BOM, tab indentation, a one-line object, non-ASCII text and trailing spaces |
| json/jsonc-comments.json | comments and trailing commas: accepted by the jsonc adapter, errors for the strict json adapter |
| json/malformed-trailing-comma.json | malformed for strict JSON: a trailing comma before } |
| json/minified.json | one-line JSON without a final line break |
| launch/SYNTHETIC.md | the list of the launch fixtures |
| launch/palworld.txt | dash flags with = values, bare flags and a positional key=value |
| launch/ark-chain.txt | an ARK question-mark chain with a quoted value, an empty value and a bare option, followed by dash flags |
| launch/source-plus.txt | dash flags with separate values and plus convars |
| launch/quoted.txt | double and single quoted values, an empty value, a line continuation and a CRLF at the end |
| launch/malformed-unclosed-quote.txt | malformed: a quote that is not closed |
| lua/SYNTHETIC.md | the list of the lua fixtures |
| lua/sandbox-like.lua | a global assignment shaped like Project Zomboid's SandboxVars: nested tables, -- and --[[ ]] comments, integers, floats, a negative and a hex number, both quote styles, an escaped quote, booleans, nil, a bracket key and a positional list |
| lua/return-table.lua | a return { ... } chunk shaped like a worldgen override: CRLF, a BOM, a one-line nested table, a long-bracket string and trailing spaces |
| lua/malformed-unclosed-table.lua | malformed: a table that is never closed |
| shellvar/SYNTHETIC.md | the list of the shellvar fixtures |
| shellvar/linuxgsm.cfg | a LinuxGSM-style cfg: double and single quotes, ${var} references kept as text, export, a comment after a value, trailing spaces and a duplicate that wins |
| shellvar/sample.env | a .env file: a backslash escape, escaped quotes and $ inside double quotes, an empty value and a single-quoted literal |
| shellvar/environmentfile.conf | a systemd EnvironmentFile: an unquoted value with spaces, double and single quotes, a ; comment and an indented line with spaces around = |
| shellvar/malformed-unclosed-quote.cfg | malformed: a double quote that is not closed |
| textlist/SYNTHETIC.md | the list of the textlist fixtures |
| textlist/adminlist-like.txt | a plain list of player ids: a // comment header, a blank line, spaces around an id, a comment between ids and no final line break |
| textlist/crlf-bom.txt | a list with a UTF-8 BOM and CRLF line endings |
| ueini/SYNTHETIC.md | the list of the ueini fixtures |
| ueini/palworld-optionsettings.ini | Palworld one-line OptionSettings struct: nested parentheses, quoted strings with a comma and parentheses inside, empty strings, Title-case booleans, six-decimal floats |
| ueini/palworld-crlf-bom.ini | the same struct with CRLF line endings, a UTF-8 BOM, trailing spaces and an escaped quote |
| ueini/array-ops.ini | +Key, -Key, .Key and !Key array operations, a duplicate key that differs only in case, a repeated section, a key outside any section and an unknown key |
| ueini/malformed-unclosed-struct.ini | malformed: the OptionSettings struct is never closed |
| xml/SYNTHETIC.md | the list of the xml fixtures |
| xml/serverconfig-like.xml | a property list shaped like 7 Days to Die's serverconfig.xml: comments, a commented-out property, attribute order value-before-name, single quotes, entities, a non-empty element, trailing spaces and an unknown element |
| xml/crlf-bom.xml | CRLF line endings, a BOM, two-space indentation and a non-ASCII value |
| xml/malformed-unclosed-tag.xml | malformed: a property tag that is never closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
