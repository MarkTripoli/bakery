import { assertEquals, assertThrows } from "@std/assert";
import { INNGEST_EVENT_DEFINITIONS } from "../../packages/contracts/src/events.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

Deno.test("pinned import event is separate from strict workflow request", () => {
  const workflow = INNGEST_EVENT_DEFINITIONS["run.requested"];
  const imported = INNGEST_EVENT_DEFINITIONS["skill.import.requested"];
  assertEquals(workflow.name, "bakery/run.requested.v1");
  assertEquals(imported.name, "bakery/skill.import.requested.v1");
  assertEquals(
    workflow.payload.parse({ runId: "00000000-0000-4000-8000-000000000001" }),
    {
      runId: "00000000-0000-4000-8000-000000000001",
    },
  );
  assertThrows(() =>
    workflow.payload.parse({
      runId: "00000000-0000-4000-8000-000000000001",
      kind: "skill_import",
    })
  );
  assertThrows(() =>
    imported.payload.parse({
      runId: "00000000-0000-4000-8000-000000000001",
      sourceId: "00000000-0000-4000-8000-000000000002",
    })
  );
});

Deno.test("source registration and import admission contracts are strict", () => {
  assertEquals(
    contractSchemas.SkillSourceCreate.parse({
      sourceType: "git",
      url: "https://github.com/example/skills.git",
      name: "Example skills",
      license: "MIT",
    }).sourceType,
    "git",
  );
  assertEquals(
    contractSchemas.SkillImport.parse({
      sourceId: "00000000-0000-4000-8000-000000000002",
      revision: "v1.2.3",
    }).path,
    undefined,
  );
  assertThrows(() =>
    contractSchemas.SkillImport.parse({
      sourceId: "00000000-0000-4000-8000-000000000002",
      revision: "v1.2.3",
      unexpected: true,
    })
  );
});
