import { assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { stepSkillIssues } from "../../apps/server/src/modules/workflows/version-skills.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Item = {
  stepPath: string;
  skillVersionId: string | null;
  skillName: string | null;
  scope: string | null;
  ownerDisplayName: string | null;
  mine: boolean;
  status: string;
  publishedVersionUsesIt: boolean;
};
type Version = { id: string; version: number; status: string };

Deno.test("a workflow shows who may use each personal skill, and a copy keeps only a slot", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const skillResponse = await f.post(
      f.ownerCookie,
      "/v1/skills",
      { slug: "my-notes", name: "My notes", scope: "personal" },
      "reads-personal-skill",
    );
    assertEquals(skillResponse.status, 201, await skillResponse.clone().text());
    const skill = await skillResponse.json() as { id: string };
    const skillVersion = await f.insertSkillVersion(skill.id);
    const workflowResponse = await f.post(
      f.ownerCookie,
      "/v1/workflows",
      { slug: "reads-flow", name: "Reads flow", description: "Reads flow" },
      "reads-workflow",
    );
    assertEquals(
      workflowResponse.status,
      201,
      await workflowResponse.clone().text(),
    );
    const workflow = await workflowResponse.json() as { id: string };
    const versionsPath = `/v1/workflows/${workflow.id}/versions`;
    const definition = {
      steps: [{ id: "write", action: "agent.run", skills: [skillVersion] }],
    };
    const created = await f.post(
      f.ownerCookie,
      versionsPath,
      { definition, confirmPersonalSkillUse: [skillVersion] },
      "reads-draft",
    );
    assertEquals(created.status, 201, await created.clone().text());
    const draft = await created.json() as Version;
    const skillsPath = `${versionsPath}/${draft.id}/skills`;
    const items = async (cookie: string, path = skillsPath) => {
      const response = await f.read(cookie, path);
      assertEquals(response.status, 200, await response.clone().text());
      return (await response.json() as { items: Item[] }).items;
    };

    // The owner sees the skill as available and as theirs.
    const [mine] = await items(f.ownerCookie);
    assertEquals(mine.status, "available");
    assertEquals(mine.mine, true);
    assertEquals(mine.skillName, "My notes");
    assertEquals(mine.ownerDisplayName, "Skill Owner");
    assertEquals(mine.stepPath, "/steps/0");

    // Another Admin sees a placeholder: name, owner and version, nothing else.
    const [theirs] = await items(f.adminCookie);
    assertEquals(theirs.status, "available");
    assertEquals(theirs.mine, false);
    assertEquals(theirs.skillName, "My notes");
    assertEquals(theirs.ownerDisplayName, "Skill Owner");
    assertEquals(theirs.publishedVersionUsesIt, false);
    assertEquals("skillId" in theirs, false);

    const issuesFor = (workflowId: string | null, definitionValue: unknown) =>
      withPgTransaction(
        f.fixture.pgDatabase,
        (transaction) =>
          stepSkillIssues(transaction, {
            organizationId: f.organizationId,
            principalId: f.adminPrincipalId,
            workflowId,
            definition: definitionValue,
          }),
      );
    assertEquals(await issuesFor(workflow.id, definition), []);

    // A copy never carries the personal skill: the step keeps a slot instead.
    const copyResponse = await f.post(
      f.ownerCookie,
      `/v1/workflows/${workflow.id}/copy`,
      {
        slug: "reads-flow-copy",
        name: "Reads flow copy",
        description: "A copy",
        sourceVersionId: draft.id,
      },
      "reads-copy",
    );
    assertEquals(copyResponse.status, 201, await copyResponse.clone().text());
    const copy = await copyResponse.json() as { id: string };
    const copyVersions = await (await f.read(
      f.ownerCookie,
      `/v1/workflows/${copy.id}/versions`,
    )).json() as { items: Version[] };
    const copyDraft = copyVersions.items.find((item) =>
      item.status === "draft"
    )!;
    const copyBody = await (await f.read(
      f.ownerCookie,
      `/v1/workflows/${copy.id}/versions/${copyDraft.id}`,
    )).text();
    assertEquals(copyBody.includes(skillVersion), false);
    const [slot] = await items(
      f.adminCookie,
      `/v1/workflows/${copy.id}/versions/${copyDraft.id}/skills`,
    );
    assertEquals(slot.status, "missing");
    assertEquals(slot.skillVersionId, null);
    assertEquals(slot.skillName, "My notes");
    assertEquals(slot.stepPath, "/steps/0");
    const copyDefinition = { steps: [{ id: "write", action: "agent.run" }] };
    assertEquals(
      (await issuesFor(copy.id, copyDefinition)).map((issue) => [
        issue.path,
        issue.code,
      ]),
      [["/steps/0/skills", "step_skill_slot_open"]],
    );

    // Settling the slot (choosing another skill or removing it) closes it.
    const resolved = await f.patch(
      f.adminCookie,
      `/v1/workflows/${copy.id}/versions/${copyDraft.id}`,
      { definition: copyDefinition, resolveSkillSlots: ["/steps/0"] },
      "reads-resolve",
      copyDraft.version,
    );
    assertEquals(resolved.status, 200, await resolved.clone().text());
    assertEquals(
      await items(
        f.adminCookie,
        `/v1/workflows/${copy.id}/versions/${copyDraft.id}/skills`,
      ),
      [],
    );
    assertEquals(await issuesFor(copy.id, copyDefinition), []);

    // When the owner stops the workflow using the skill, the step reports it
    // and publishing refuses it.
    const grantsPath = `/v1/skills/${skill.id}/use-grants`;
    const grants = await (await f.read(f.ownerCookie, grantsPath)).json() as {
      items: { id: string; version: number }[];
    };
    const stop = await f.del(
      f.ownerCookie,
      `${grantsPath}/${grants.items[0].id}`,
      "reads-stop",
      grants.items[0].version,
    );
    assertEquals(stop.status, 204);
    for (const cookie of [f.ownerCookie, f.adminCookie]) {
      assertEquals((await items(cookie))[0].status, "stopped");
    }
    assertEquals(
      (await issuesFor(workflow.id, definition)).map((issue) => [
        issue.path,
        issue.code,
      ]),
      [["/steps/0/skills", "step_skill_stopped"]],
    );
  } finally {
    await f.close();
  }
});
