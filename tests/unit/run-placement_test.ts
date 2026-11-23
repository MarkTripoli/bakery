import { assertEquals, assertThrows } from "@std/assert";
import { RunPlacementSchema } from "../../packages/contracts/src/repository-inspection.ts";
import { hostMeetsJobRequirements } from "../../packages/persistence/src/job-platform.ts";
import { withRunPlacement } from "../../packages/persistence/src/repository-admission.ts";

// #428 part 1: placement is data on the run. It only adds gates to a job's
// own requirements, and the existing claim rule enforces the result.

const linuxGit = { os: "linux", capabilities: ["git", "model"] };
const linuxNoModel = { os: "linux", capabilities: ["git"] };

Deno.test("a run with no placement leaves a job's requirements untouched", () => {
  const job = { capabilities: ["git"], platform: "linux" };
  assertEquals(withRunPlacement(job, null), job);
  assertEquals(withRunPlacement(job, RunPlacementSchema.parse({})), job);
});

Deno.test("an empty stored placement parses to no constraint", () => {
  assertEquals(RunPlacementSchema.parse({}), {
    requirements: { capabilities: [] },
  });
});

Deno.test("placement capabilities join the job's and the claim rule honours them", () => {
  const placement = RunPlacementSchema.parse({
    requirements: { capabilities: ["model", "git"] },
    affinityKey: "run-a",
  });
  const merged = withRunPlacement({ capabilities: ["git"] }, placement);
  assertEquals(merged.capabilities, ["git", "model"]);
  assertEquals(hostMeetsJobRequirements(merged, linuxGit), true);
  assertEquals(hostMeetsJobRequirements(merged, linuxNoModel), false);
});

Deno.test("placement supplies a platform the job did not name", () => {
  const placement = RunPlacementSchema.parse({
    requirements: { platform: "macos" },
  });
  const merged = withRunPlacement({ capabilities: ["git"] }, placement);
  assertEquals(merged.platform, "macos");
  assertEquals(hostMeetsJobRequirements(merged, linuxGit), false);
});

Deno.test("a placement platform that contradicts the job's refuses instead of weakening it", () => {
  const placement = RunPlacementSchema.parse({
    requirements: { platform: "macos" },
  });
  assertThrows(
    () =>
      withRunPlacement({ capabilities: ["git"], platform: "linux" }, placement),
  );
});
