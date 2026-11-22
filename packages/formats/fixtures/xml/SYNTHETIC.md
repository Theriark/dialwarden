# Synthetic fixtures

Every file in this folder was written by Theriark for the Dialwarden tests.
None is a copy of a game publisher's default file or of wiki text; each
reproduces only a format, its key names and its known quirks (legal-input-1,
section 2).

| File | What it reproduces |
| --- | --- |
| serverconfig-like.xml | a property list shaped like 7 Days to Die's serverconfig.xml: comments, a commented-out property, attribute order value-before-name, single quotes, entities, a non-empty element, trailing spaces and an unknown element |
| crlf-bom.xml | CRLF line endings, a BOM, two-space indentation and a non-ASCII value |
| malformed-unclosed-tag.xml | malformed: a property tag that is never closed |

The CI hygiene job fails when a fixtures folder has no SYNTHETIC.md or when a
file in it is not listed here.
