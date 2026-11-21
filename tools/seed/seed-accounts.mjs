#!/usr/bin/env node
// Seeds the test accounts of a Development or Stage instance (dev-work-plan
// P1-A step 9, references/test-accounts.md). P1 seeds the owner; P8 adds
// admin, editor and viewer. See src/lib.mjs.
//   node tools/seed/seed-accounts.mjs \
//     --base-url https://app-dev-dialwarden.theriark.dev --env dev
// Stage is seeded after Gate 2 by the operator or the gate script, never by
// the crew.
import { main } from "./src/lib.mjs";

process.exitCode = await main(process.argv.slice(2));
