# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden demo
server and tests. None of it is a publisher default file and no text comes
from a wiki or a publisher page.

| File | What it reproduces |
| --- | --- |
| server.cfg | console convars with quoted and bare values side by side (the quoted server.saveinterval "300" and the bare server.seed on the launch line are the known trap: an unquoted value with spaces keeps only its first word), a comment only where # is the first character, an indented # line and a // line that the game would run as commands, an unknown convar with a stray colon, a convar the game renamed and a commented-out convar, all kept byte for byte |
| users.cfg | ownerid and moderatorid lines with quoted names and an optional quoted reason, no final newline; the Steam IDs are made-up numbers |
| dialwarden-args.txt | the launch line the game reads: quoted values where spaces need them, the identity convar kept as an unknown entry, and -logfile as a dash flag with a value word |

The pack follows the LinuxGSM layout, so the config files live under
server/rustserver for the default instance name; an instance with another
identity keeps its files under server/<identity> instead.
