# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| palworld.txt | dash flags with = values, bare flags and a positional key=value |
| ark-chain.txt | an ARK question-mark chain with a quoted value, an empty value and a bare option, followed by dash flags |
| source-plus.txt | dash flags with separate values and plus convars |
| quoted.txt | double and single quoted values, an empty value, a line continuation and a CRLF at the end |
| malformed-unclosed-quote.txt | malformed: a quote that is not closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
