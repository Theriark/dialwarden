# Synthetic fixtures

Every file in this folder was written by Theriark for the detection tests. They
reproduce the KeyValues layout SteamCMD uses for steamapps/appmanifest_APPID.acf
for a made-up app id (4000001); none is a copy of a real manifest.

| File | What it reproduces |
| --- | --- |
| appmanifest_4000001.acf | a complete manifest with tab-separated pairs, a build id and nested depot blocks |
| lowercase-no-build.acf | keys in other letter cases, a // comment, escaped quotes and backslashes, a one-line block and no build id |
| malformed-unclosed.acf | malformed: blocks that are never closed |
