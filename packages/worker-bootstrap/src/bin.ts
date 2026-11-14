import process from "node:process";
import { main } from "./process-main.ts";
import { RELEASE_CONFIG } from "./release-config.ts";

/** `bakery-worker setup|pair|status|doctor|drain|plan`, with the release origin this build was made for. */
process.exit(await main(process.argv.slice(2), RELEASE_CONFIG));
