// The npm tarball the server serves for `npx <origin>/v1/worker/link.tgz`
// (#70) is built from a committed bundle of packages/worker-bootstrap. The
// bundle records the digest of the source it was made from; a stale bundle
// fails here instead of shipping old code. Fix: `pnpm worker-link:generate`.
import { assertEquals } from "@std/assert";
import { workerBootstrapSourceDigest } from "../../scripts/generate-worker-link-bundle.ts";
import { WORKER_LINK_SOURCE_DIGEST } from "../../packages/worker-bootstrap/generated/link-bundle.ts";

Deno.test("the served link bundle was built from the current bootstrap source", async () => {
  assertEquals(WORKER_LINK_SOURCE_DIGEST, await workerBootstrapSourceDigest());
});
