# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden demo
server and tests. None of it is a publisher default file and no text comes
from a wiki or a publisher page.

| File | What it reproduces |
| --- | --- |
| GameUserSettings.ini | Unreal Engine style with a UTF-8 byte order mark and CRLF line endings, True and False booleans, six-decimal floats next to bare integers, a duplicate [ServerSettings] block, the misplaced-key trap (Game.ini keys inside [ServerSettings] and the transfer keys inside the client section where the server never reads them), and the wrong-section copies of the session name and the slot limit |
| Game.ini | the game keys at their defaults with the same six-decimal floats, the indexed per-level keys, an array-operation line and a repeated unknown key the pack does not address, and the reverse misplaced GameUserSettings keys |
| dialwarden-args.txt | the travel chain in quotes with the admin password in the middle followed by more options (the known trap: everything after the password becomes part of it), the port as both a question-mark option and the dash flag, and the dash flags an install script adds |

The whole pack is stopped-only because the server rewrites
GameUserSettings.ini at shutdown, reordering keys and dropping lines it
does not know.
