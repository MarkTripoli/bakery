import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  deriveWorkspaceRequirement,
  isWorkTypeLabel,
  resolveScopeProfileDefaults,
  WORK_TYPE_LABEL_MAX_LENGTH,
} from "../../packages/contracts/src/scope-profiles.ts";

// #433 slice A of the one-engine design (§15.1, O23): a run needs exactly the
// workspaces its steps declare, work type is an organization label the kernel
// never branches on, and step defaults come from a project-level scope profile
// rather than a repository profile.

Deno.test("a workflow whose steps declare no workspace needs none", () => {
  const requirement = deriveWorkspaceRequirement([
    { uses: "workflow.noop" },
    { uses: "task.brief", with: { brief: "$input.brief" } },
  ]);
  assertFalse(requirement.required);
  assertEquals(requirement.workspaces, []);
  assertEquals(requirement.reason, "no_step_declares_a_workspace");
});

Deno.test("a step requiring git makes the run need a workspace", () => {
  const requirement = deriveWorkspaceRequirement([
    { uses: "workflow.noop" },
    { uses: "harness.implement", requires: ["git"] },
  ]);
  assert(requirement.required);
  assertEquals(requirement.reason, "a_step_requires_a_workspace");
});

Deno.test("a step naming a workspace alias contributes that workspace", () => {
  const requirement = deriveWorkspaceRequirement([
    { uses: "tool.call", workspace: { name: "media", access: "write" } },
  ]);
  assert(requirement.required);
  assertEquals(requirement.workspaces, [
    { name: "media", access: "write" },
  ]);
});

Deno.test("one read and one write mount of a name keep the writable access", () => {
  const requirement = deriveWorkspaceRequirement([
    { uses: "tool.call", workspace: { name: "media", access: "read" } },
    { uses: "tool.call", workspace: { name: "media", access: "write" } },
  ]);
  assertEquals(requirement.workspaces, [
    { name: "media", access: "write" },
  ]);
});

Deno.test("workspace declarations are ordered by name, not appearance", () => {
  const requirement = deriveWorkspaceRequirement([
    { uses: "tool.call", workspace: { name: "zeta", access: "read" } },
    { uses: "tool.call", workspace: { name: "alpha", access: "write" } },
  ]);
  assertEquals(
    requirement.workspaces.map((workspace) => workspace.name),
    ["alpha", "zeta"],
  );
});

Deno.test("nested steps are inspected, not only the top level", () => {
  const requirement = deriveWorkspaceRequirement([
    {
      uses: "workflow.noop",
      steps: [{ uses: "tool.call", requires: ["git"] }],
    },
  ]);
  assert(requirement.required);
});

Deno.test("a malformed workspace declaration is refused, not ignored", () => {
  for (
    const workspace of [
      { access: "read" },
      { name: "", access: "read" },
      { name: "a b", access: "read" },
      { name: "media", access: "append" },
    ]
  ) {
    try {
      deriveWorkspaceRequirement([{ uses: "tool.call", workspace }]);
    } catch (error) {
      assert(
        error instanceof Error,
        `expected an Error for ${JSON.stringify(workspace)}`,
      );
      continue;
    }
    throw new Error(
      `expected a refusal for ${JSON.stringify(workspace)}`,
    );
  }
});

Deno.test("work types are organization labels the kernel does not branch on", () => {
  // The four software-delivery labels stay valid defaults.
  for (const label of ["feature", "bug", "epic", "maintenance"]) {
    assert(isWorkTypeLabel(label), `${label} must stay a valid work type`);
  }
  // Any organization label is accepted, so a non-code factory can name its own.
  for (const label of ["episode", "datasets", "video-cut", "a1"]) {
    assert(isWorkTypeLabel(label), `${label} must be accepted as a label`);
  }
  for (
    const label of [
      "",
      " ",
      "Episodes",
      "episode series",
      "-leading",
      "trailing-",
      "double--dash",
      "x".repeat(WORK_TYPE_LABEL_MAX_LENGTH + 1),
    ]
  ) {
    assertFalse(isWorkTypeLabel(label), `${label} must be refused`);
  }
});

Deno.test("a project scope profile supplies the step defaults", () => {
  const defaults = resolveScopeProfileDefaults({
    organizationId: "00000000-0000-4000-8000-0000000000o1",
    applicationId: "00000000-0000-4000-8000-0000000000p1",
    profile: {
      revision: 3,
      digest: "a".repeat(64),
      checkCommands: [{ id: "unit", command: "pnpm test:unit" }],
      rules: [],
    },
  });
  assertEquals(defaults.revision, 3);
  assertEquals(defaults.checkCommands, [
    { id: "unit", command: "pnpm test:unit" },
  ]);
});

Deno.test("an absent project scope profile resolves to the empty baseline", () => {
  const defaults = resolveScopeProfileDefaults({
    organizationId: "00000000-0000-4000-8000-0000000000o1",
    applicationId: "00000000-0000-4000-8000-0000000000p1",
    profile: null,
  });
  assertEquals(defaults.revision, 0);
  assertEquals(defaults.digest, "");
  assertEquals(defaults.checkCommands, []);
  assertEquals(defaults.rules, []);
});

Deno.test("a scope profile from another project is refused", () => {
  try {
    resolveScopeProfileDefaults({
      organizationId: "00000000-0000-4000-8000-0000000000o1",
      applicationId: "00000000-0000-4000-8000-0000000000p1",
      profile: {
        revision: 1,
        digest: "b".repeat(64),
        checkCommands: [],
        rules: [],
        applicationId: "00000000-0000-4000-8000-0000000000p2",
      },
    });
  } catch (error) {
    assert(error instanceof Error);
    return;
  }
  throw new Error("a scope profile from another project must be refused");
});

Deno.test("the task picker offers the four labels and keeps a foreign one visible", async () => {
  const composer = await import(
    "../../packages/ui/src/atoms/task-composer-task-types.ts"
  );
  // The four software-delivery labels stay on offer.
  assertEquals([...composer.TASK_COMPOSER_TASK_TYPES], [
    "feature",
    "bug",
    "epic",
    "maintenance",
  ]);
  for (const label of composer.TASK_COMPOSER_TASK_TYPES) {
    assert(composer.isTaskComposerTaskType(label));
  }
  // An organization label the picker does not offer is not silently treated as
  // one of the four: the form must show the row's real label.
  for (const label of ["design-review", "episode", ""]) {
    assertFalse(
      composer.isTaskComposerTaskType(label),
      `${label} must not be read as one of the four offered labels`,
    );
  }
});
