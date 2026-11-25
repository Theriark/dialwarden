# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden demo
server and tests. None of it is a publisher default file and no text comes
from a wiki or a publisher page.

| File | What it reproduces |
| --- | --- |
| serverconfig.xml | the V3 property list with tab alignment, trailing comments in our own words, CRLF line endings and a declaration without encoding, four properties closed with a space before the slash the way the stock file mixes both styles, an active UserDataFolder inside the server root, the 31 pre-V3 keys an upgraded server still carries and one unknown mod property, all kept as they are |
| serveradmin.xml | the admin, whitelist, ban and token lists as commented examples with made-up ids, a live per-command permission list, empty self-closing web modules and users, and no newline after the closing root tag |
| dialwarden-args.txt | the start flags: the config file in the inline -configfile= form the game documents, then the headless and quit switches the wrapper adds, kept as written |

The admin file resolves inside the Saves folder of the data directory, so
the demo sets UserDataFolder to a folder in the server root; with it unset
the game keeps the file in the user profile instead.
