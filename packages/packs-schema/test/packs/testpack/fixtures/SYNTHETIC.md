# Synthetic fixtures

Every file in this folder was written by Theriark for the packs-schema tests.
They belong to a made-up game ("testpack") and copy no game publisher's file
or wiki text (legal-input-1, section 2).

| File | What it reproduces |
| --- | --- |
| Game.ini | an Unreal INI file with a settings section, a quoted name, an empty value and a one-line struct |
| Engine.ini | a second Unreal INI file of the same game, for the wrong-file lint |
| launch.txt | a start command with a dash flag that has a value and a bare flag |
| testserver.cfg | a LinuxGSM-style shell variable file with start parameters |
