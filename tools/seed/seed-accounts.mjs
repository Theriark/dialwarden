#!/usr/bin/env node
// Seeds the owner of a fresh Stage instance through the setup API (dev-work-plan
// P1-A step 9, references/test-accounts.md, R&D decision THE-2141). On
// Development the owner comes from DEV_SEED_OWNER_EMAIL and
// DEV_SEED_OWNER_PASSWORD at start instead. See src/lib.mjs.
//   node tools/seed/seed-accounts.mjs \
//     --base-url https://app-stg-dialwarden.theriark.dev --env stage \
//     --setup-token TOKEN
// TOKEN is in DATA_DIR/setup-token or the start log of the Stage container.
// Stage is seeded after Gate 2 by the operator or the gate script, never by
// the crew.
import { main } from "./src/lib.mjs";

process.exitCode = await main(process.argv.slice(2));
