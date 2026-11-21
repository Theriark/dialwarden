# Third-party licences

`pnpm run licence:audit` (CI job "2 - dependency audit and licence audit") reads
this file. Every installed package, runtime and development, must carry a
licence on the allow-list below, or appear in the reviewed exceptions. SPDX
expressions are evaluated: `A OR B` needs one allowed side, `A AND B` needs
both, `A WITH exception` needs `A`. A package without a recognised licence
fails.

`pnpm run notices` writes `THIRD_PARTY_NOTICES` for the production packages at
build time (Dockerfile build stage); the image ships it as
`/app/THIRD_PARTY_NOTICES`. It is not committed.

## Allowed licences

- `MIT`
- `Apache-2.0`
- `ISC`
- `BSD-2-Clause`
- `BSD-3-Clause`
- `0BSD`
- `CC0-1.0`
- `BlueOak-1.0.0`
- `OFL-1.1` (fonts)

## Reviewed exceptions

Scope `dev`: allowed only while the package is not a production dependency; the
audit fails if it reaches the image. Scope `all`: allowed in the image too, and
needs Legal's agreement in the pull request. Add a row only with a reason.

| Package | Licence | Scope | Reason |
| --- | --- | --- | --- |
| `argparse` | `Python-2.0` | dev | YAML parser dependency of the linter (eslint, @eslint/eslintrc, js-yaml); never in the image |

## How to change this list

A new licence on the allow-list, or an exception with scope `all`, needs Legal's
review (legal-input-1, section 1, third-party components). Copyleft licences
(GPL, LGPL, AGPL, MPL) are not allowed in the application code.
