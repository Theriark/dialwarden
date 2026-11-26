# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden server
tests. None holds customer data or a copy of a game publisher's file.

| File | What it reproduces |
| --- | --- |
| p1-data.sql | the rows of a database as phase P1 left it (migrations 0001 and 0002): one owner, one session, two settings and three activity events that name their actor by e-mail address, as P1 did; the upgrade test migrates it to the newest migration |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
