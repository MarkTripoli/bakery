import { assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { collectStepSkills } from "../../apps/server/src/modules/catalog/skill-use-grants.ts";

const version = "0a1b2c3d-0000-4000-8000-0123456789ab";

function refusedWith(run: () => unknown): string {
  const error = assertThrows(run, StandardError);
  return JSON.stringify((error as StandardError).params);
}

Deno.test("a skill version named in upper case is collected in the lower case the database stores", () => {
  const refs = collectStepSkills({
    steps: [{
      id: "write",
      action: "agent.run",
      skills: [version.toUpperCase()],
    }],
  });
  assertEquals(refs.map((ref) => ref.versionId), [version]);
});

Deno.test("a step as authored (uses) is collected like a compiled one (action)", () => {
  const authored = collectStepSkills({
    steps: [{ id: "write", uses: "harness.implement", skills: [version] }],
  });
  assertEquals(authored.map((ref) => ref.versionId), [version]);
  assertEquals(authored.map((ref) => ref.segments), [["steps", 0]]);
  // Neither marker, no step: a bare list of ids elsewhere is not a skill reference.
  assertEquals(
    collectStepSkills({ steps: [{ id: "x", skills: [version] }] }),
    [],
  );
});

Deno.test("a definition that names more skill versions than the check reads is refused, not truncated", () => {
  const skills = Array.from(
    { length: 257 },
    () => crypto.randomUUID(),
  );
  const refused = refusedWith(() =>
    collectStepSkills({ steps: [{ id: "write", action: "agent.run", skills }] })
  );
  assertEquals(refused.includes("too_many_skill_references"), true, refused);
});

Deno.test("a definition nested deeper than the check walks is refused, not skipped", () => {
  let deep: unknown = {
    id: "write",
    action: "agent.run",
    skills: [version],
  };
  for (let level = 0; level < 40; level += 1) deep = { child: deep };
  const refused = refusedWith(() => collectStepSkills(deep));
  assertEquals(
    refused.includes("definition_too_deep_to_check_skills"),
    true,
    refused,
  );
});

Deno.test("a definition within both limits is read whole", () => {
  const skills = Array.from({ length: 256 }, () => crypto.randomUUID());
  assertEquals(
    collectStepSkills({ steps: [{ id: "write", action: "agent.run", skills }] })
      .length,
    256,
  );
});
