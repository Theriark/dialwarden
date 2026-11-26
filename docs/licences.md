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
| `lightningcss` | `MPL-2.0` | dev | CSS compiler that Tailwind CSS v4 (@tailwindcss/vite) runs while apps/web builds; only its CSS output ships, never the package |
| `lightningcss-linux-x64-gnu` | `MPL-2.0` | dev | Platform binary of lightningcss (see above); build tool only |
| `lightningcss-linux-x64-musl` | `MPL-2.0` | dev | Platform binary of lightningcss (see above); build tool only |
| `lightningcss-linux-arm64-gnu` | `MPL-2.0` | dev | Platform binary of lightningcss (see above); build tool only |
| `lightningcss-linux-arm64-musl` | `MPL-2.0` | dev | Platform binary of lightningcss (see above); build tool only |
| `lightningcss-darwin-arm64` | `MPL-2.0` | dev | Platform binary of lightningcss (see above); local builds only |
| `caniuse-lite` | `CC-BY-4.0` | dev | Browser support data read by browserslist during the apps/web build (@vitejs/plugin-react, Babel); the data does not ship |
| `@csstools/color-helpers` | `MIT-0` | dev | Colour helpers of jsdom's CSS parser (cssstyle), used by the apps/web unit tests only |
| `isbot` | `Unlicense` | all | Dependency of @tanstack/react-router, the apps/web router, used only by its server-side rendering entry that apps/web does not import, so it is not expected in the built bundle; Unlicense is a public-domain dedication with no conditions. Pending Legal's agreement on the pull request (THE-2121) |
| `nodemailer` | `MIT-0` | all | The SMTP e-mail notification channel (dev-work-plan P9-B); MIT-0 grants the MIT rights without the attribution condition, and the package has no runtime dependencies. Pending Legal's agreement on the pull request (THE-2812) |
| `tweetnacl` | `Unlicense` | all | Dependency of bcrypt-pbkdf, which ssh2 (the SFTP connector, dev-work-plan P4-A) requires to read passphrase-protected OpenSSH keys; the instance key Dialwarden makes has no passphrase, but ssh2 always loads the package. Unlicense is a public-domain dedication with no conditions (as for isbot). Agreed by Legal (THE-2389) |

## How to change this list

A new licence on the allow-list, or an exception with scope `all`, needs Legal's
review (legal-input-1, section 1, third-party components). Copyleft licences
(GPL, LGPL, AGPL, MPL) are not allowed in the application code.
