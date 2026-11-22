/**
 * #42 [B13.04] contract proofs: the published surface of scoped skills. Used by
 * names workflows and agents, so whoever may read it must be able to open what
 * it lists; and every write the page repeats on a retry is idempotent.
 */
import { assert, assertEquals } from "@std/assert";
import { clientManifest } from "../../packages/contracts/generated/client-manifest.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { rolePermissions } from "../../apps/server/src/modules/auth/application/permissions.ts";

type ManifestAction = (typeof clientManifest.actions)[number];

function action(name: string): ManifestAction {
  const found = clientManifest.actions.find((entry) => entry.action === name);
  assert(found !== undefined, `${name} is not in the client manifest`);
  return found;
}

Deno.test("Used by is a cursor read of one skill, refused or not found before anything is listed", () => {
  const usedBy = action("skills.usedBy");
  assertEquals(usedBy.method, "GET");
  assertEquals(usedBy.path, "/v1/skills/{id}/used-by");
  assertEquals(usedBy.permission, "skill:read");
  assertEquals(usedBy.output, "Page<SkillUsage>");
  assertEquals(usedBy.idempotency, "read");
  for (const code of ["RESOURCE_NOT_FOUND", "INVALID_CURSOR"]) {
    assert((usedBy.errors as readonly string[]).includes(code), code);
  }
});

Deno.test("every role that may read Used by may open each workflow and agent it lists", () => {
  const usedBy = action("skills.usedBy");
  const workflow = action("workflows.get");
  const workflowVersion = action("workflowVersions.get");
  const agent = action("agents.get");
  // The same role floor as the reads of what it lists ...
  for (const opened of [workflow, workflowVersion, agent]) {
    assertEquals(opened.access, usedBy.access, opened.action);
  }
  // ... and, role by role, the permissions to open them.
  for (const [role, permissions] of Object.entries(rolePermissions)) {
    const held = new Set<string>(permissions);
    if (!held.has(usedBy.permission ?? "")) continue;
    for (const opened of [workflow, workflowVersion, agent]) {
      assert(
        held.has(opened.permission ?? ""),
        `${role} reads Used by but not ${opened.action}`,
      );
    }
  }
});

Deno.test("saving, copying and publishing a skill are each replay-safe writes", () => {
  for (
    const [name, idempotency] of [
      ["skills.update", "Idempotency-Key required; PATCH also If-Match"],
      ["skillDraftFiles.save", "Idempotency-Key + If-Match required"],
      ["skills.copy", "Idempotency-Key required"],
      ["skillDrafts.publish", "Idempotency-Key + If-Match required"],
    ] as const
  ) {
    const write = action(name);
    assertEquals(write.idempotency, idempotency, name);
    assertEquals(write.permission, "skill:author", name);
  }
});

Deno.test("a Used by row names one workflow or agent version and the skill versions it pins", () => {
  const page = contractSchemas["Page<SkillUsage>"];
  const row = {
    kind: "workflow",
    definitionId: crypto.randomUUID(),
    definitionName: "Research",
    versionId: crypto.randomUUID(),
    revision: 1,
    skillVersionIds: [crypto.randomUUID()],
    createdAt: "2026-11-21T00:00:00.000000Z",
  };
  assert(page.safeParse({ items: [row], nextCursor: null }).success);
  // Only workflows and agents use a skill.
  assertEquals(
    page.safeParse({ items: [{ ...row, kind: "task" }], nextCursor: null })
      .success,
    false,
  );
});
