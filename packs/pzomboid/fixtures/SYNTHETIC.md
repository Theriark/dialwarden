# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden demo
server and tests. None of it is a publisher default file and no text comes
from a wiki or a publisher page.

| File | What it reproduces |
| --- | --- |
| servertest.ini | the flat key layout of the Build 42 server ini with empty values where the game stores its passwords and mod lists, a welcome message holding the game's line-break tag, two comments that use decimal commas the way non-English hosts write them, a Build 41 key pair kept as ignored, and one unknown Build 42 key |
| servertest_SandboxVars.lua | the nested SandboxVars table of Build 42: VERSION 6, flat keys, the Basement, Map, ZombieLore, ZombieConfig and MultiplierConfig sub-tables with a trailing comma after every entry including the last, names that repeat at different depths (Strength in ZombieLore and MultiplierConfig), three Build 41 keys kept as ignored and a mod-added table the pack does not know |
| dialwarden-args.txt | the launch line the game start script reads: the server name, the data folder flag and the two Steam ports, none of them pack settings, kept as written |

The pack models the default server name servertest, so the two config files
live under Zomboid/Server; a server started with -servername NAME keeps its
files under Zomboid/Server with NAME in their file names instead.
