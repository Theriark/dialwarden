# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden demo
server and tests. None of it is a publisher default file and no text comes
from a wiki or a publisher page.

| File | What it reproduces |
| --- | --- |
| dialwarden-args.txt | one launch line with a double-quoted name (the quoting the launch adapter writes, so every value restores byte for byte), a public server, the -preset flag in front of the -modifier flags it must precede, and two-token -modifier arguments (THE-2582) |

The admin, ban and permit lists are not part of this pack yet: the game keeps
them in its save folder, which is outside the server root on a standard
install, so they wait for pack file paths that follow the -savedir setting
(code review THE-2596 F3). The textlist adapter and its own fixtures in
packages/formats stay ready for them.
