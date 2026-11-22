# Synthetic fixtures

Every file in this folder was written by Theriark for the Palworld pack tests.
None of them is a copy of a file the game publisher ships, and no text comes
from a wiki or a publisher page (legal-input-1, section 2). Key names, types
and default values are facts checked against the sources listed in
`../pack.json`; the layout, the order of the keys, the comments and every
non-default value are our own.

| File | What it reproduces |
| --- | --- |
| PalWorldSettings.ini | the one-line OptionSettings struct under its section header: every key of the pack at its default value in our own group order, a quoted name with commas and parentheses, empty quoted strings, bare enum words, True and False, floats with six decimals, a negative whole number, a nested platform list, an empty bare list (DenyTechnologyList), an old key the game no longer reads (AllowConnectPlatform) and a made-up future key (SyntheticFutureOption) that must be kept as found |
| dialwarden-args.txt | an app-managed launch line: a leading word that is not a flag (EpicApp=PalServer), flags with = values, a flag with a separate value word (-players 32), bare flags, and a single-quoted value with a space; the address is from the 203.0.113.0/24 documentation range |
