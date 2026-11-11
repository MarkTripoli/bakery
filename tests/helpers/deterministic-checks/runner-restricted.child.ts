import { join } from "node:path";
import { createCheckExecutor } from "../../../apps/worker/src/check-runner.ts";
import { createDeterministicExecutor } from "../../../apps/worker/src/executor.ts";
import type { JobAssignment } from "../../../apps/worker/src/types.ts";

/**
 * Runs one `quality.check` assignment under the exact read, write and run
 * grants the deployed worker launches with (apps/worker/scripts/run-worker.sh),
 * so a runner that looked tools up with file APIs would see PermissionDenied
 * for every tool. The parent passes the assignment as one JSON argument and
 * reads the outcome from stdout. This file imports nothing from the test
 * helpers: it must load and run under the narrow grants.
 */

type ChildInput = {
  readonly repository: string;
  readonly stateDir: string;
  readonly credentialPaths: readonly string[];
  readonly assignment: JobAssignment;
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

const input = JSON.parse(Deno.args[0]!) as ChildInput;

// Prove the grants really are narrow: /usr/bin/env is not on the read list.
let restricted = false;
try {
  await Deno.stat("/usr/bin/env");
} catch (error) {
  restricted = error instanceof Deno.errors.NotCapable;
}

const executor = createCheckExecutor(createDeterministicExecutor(), {
  repository: input.repository,
  stateDir: input.stateDir,
  commandTimeLimitMs: 20_000,
  credentialPaths: input.credentialPaths,
  publishFor: () => async (request) => ({
    artifactId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    sha256: await sha256(request.bytes),
  }),
});
const outcome = await executor.execute(
  input.assignment,
  new AbortController().signal,
);
const leftover: string[] = [];
try {
  for await (const entry of Deno.readDir(join(input.stateDir, "checks"))) {
    leftover.push(entry.name);
  }
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
console.log(JSON.stringify({ restricted, outcome, leftover }));
