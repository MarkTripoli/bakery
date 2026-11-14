import type { ReleaseConfig } from "./bootstrap.ts";

/**
 * What a release build bakes in: the fixed release origin and the trust root of
 * the keys that sign its manifests. Nothing the person or the network supplies
 * can change either, so this is a constant of the build, not an option or an
 * environment variable. It is left out here on purpose: publishing a bootstrap
 * and choosing its origin and keys is owner work behind the B00.04 allowlist,
 * and until a build sets it, `setup --release` says so and installs nothing.
 * (Tests pass their own, with local test keys and a loopback origin.)
 */
export const RELEASE_CONFIG: ReleaseConfig | undefined = undefined;
