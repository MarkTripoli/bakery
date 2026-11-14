import process from "node:process";
import { main } from "../../packages/worker-bootstrap/src/process-main.ts";
import type { ReleaseConfig } from "../../packages/worker-bootstrap/src/index.ts";

/**
 * The real command line with a test's release origin and local test keys, given
 * as JSON in BAKERY_TEST_RELEASE_CONFIG. A shipped bootstrap has its origin and
 * keys fixed at build time (`release-config.ts`) and takes no such variable.
 */
const raw = process.env.BAKERY_TEST_RELEASE_CONFIG;
const config = raw === undefined ? undefined : JSON.parse(raw) as ReleaseConfig;
process.exit(await main(process.argv.slice(2), config));
