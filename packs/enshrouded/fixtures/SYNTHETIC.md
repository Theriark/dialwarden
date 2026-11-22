# Synthetic fixtures

Every file in this folder was written by Theriark for the Enshrouded pack
tests. None of them is a copy of a file the game publisher ships, and no text
comes from a wiki or a publisher page (legal-input-1, section 2). Key names,
types and default values are facts checked against the sources listed in
`../pack.json`; the order of the custom difficulty keys, the role permissions,
the passwords, the ban entry and the made-up keys are our own.

| File | What it reproduces |
| --- | --- |
| enshrouded_server.json | strict JSON indented with one tab per level, LF line endings and no final newline, as the game writes it; every key of the pack at its default value; an empty array written over two lines (tags); the Default difficulty preset with a full custom difficulty block; four roles in the order the game creates them, one without the optional canEditWorld key; obviously fake role passwords; a ban entry whose account id is larger than 2 to the 53rd; and two made-up keys (syntheticFutureFactor inside the difficulty block, syntheticFutureKey at the top) that must be kept as found |
