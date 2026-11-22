/**
 * #448 slice S2: a step's files section with the O44 read and O45 write
 * defaults, the session scopes the claim mints from it, and the read guard
 * that judges every storage read an agent makes (chapter 25 section 17.6).
 *
 * The contract comes first: the section is a described schema the compiler
 * reads into the normalized node and the compiled plan, and every refusal is
 * named. The guard tests drive the real assertAgentFileRead and
 * assertAgentFileWrite against fixed rows, one failing layer at a time.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  compileWorkflowDocument,
  DEFAULT_STEP_FILES,
  readsOnlyInputs,
  resolveStepFiles,
  SEALED_STEP_FILES,
  sealedByDefault,
  WORKFLOW_FILE_READ_AREAS,
  WORKFLOW_FILE_WRITE_AREAS,
  WorkflowStepFilesSchema,
  WorkflowStepSealedSchema,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  AgentFileRefusal,
  agentReadAreaRefusal,
  agentRootKeys,
  AgentTreeArea,
  agentTreeAreaOf,
  type ChainEntry,
  declaredTreeAreas,
  FILES_READ_SCOPE,
  FILES_WRITE_SCOPE,
  stepFileScopes,
} from "../../apps/server/src/modules/knowledge/agent-file-scope.ts";
import { grantedScopesForStep } from "../../apps/server/src/modules/execution/session-claim-credential.ts";
import {
  type AgentFileTarget,
  assertAgentFileRead,
  assertAgentFileWrite,
} from "../../apps/server/src/modules/knowledge/agent-file-guard.ts";
import {
  assertSessionToolAllowed,
  SessionToolError,
} from "../../apps/server/src/modules/execution/session-tools.ts";
import { readScopesForSession } from "../../apps/server/src/modules/execution/session-claim-credential.ts";
import {
  INPUTS_ONLY_STEP_FILES,
  stepFilesFromSnapshot,
  UNDECLARED_STEP_FILES,
} from "../../apps/server/src/modules/execution/step-files.ts";

const ORG = "0195f000-0000-7000-8000-0000000000a1";
const OTHER_ORG = "0195f000-0000-7000-8000-0000000000a2";
const WORKFLOW = "0195f000-0000-7000-8000-0000000000b1";
const PERSON = "0195f000-0000-7000-8000-0000000000c1";
const OTHER_MEMBER = "0195f000-0000-7000-8000-0000000000c2";
const ADMIN = "0195f000-0000-7000-8000-0000000000c3";
const TASK = "0195f000-0000-7000-8000-0000000000e3";
const APP = "0195f000-0000-7000-8000-0000000000e4";
const OTHER_APP = "0195f000-0000-7000-8000-0000000000e5";
const ATTEMPT = "0195f000-0000-7000-8000-0000000000e1";
const T0 = new Date("2026-11-19T12:00:00Z");

// ------------------------------------------------------------- the contract

type Step = Record<string, unknown>;

function workflow(steps: Step[]) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "step-files",
    description: "Exercises a step's files section.",
    inputs: {},
    steps,
  };
}

async function compile(steps: Step[]) {
  return await compileWorkflowDocument(workflow(steps), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
}

const step = (extra: Step = {}): Step => ({
  id: "aa",
  uses: "workflow.noop",
  ...extra,
});

Deno.test("contract: the files section and both area lists are described", () => {
  assert((WorkflowStepFilesSchema.description ?? "").length > 40);
  for (const key of ["read", "write"] as const) {
    assert(
      (WorkflowStepFilesSchema.shape[key].description ?? "").length > 40,
      key,
    );
  }
});

Deno.test("contract: O44 and O45 are the defaults when the section is absent", () => {
  assertEquals(resolveStepFiles(undefined), DEFAULT_STEP_FILES);
  assertEquals([...DEFAULT_STEP_FILES.read], [...WORKFLOW_FILE_READ_AREAS]);
  assertEquals([...DEFAULT_STEP_FILES.write], [...WORKFLOW_FILE_WRITE_AREAS]);
  // O44: the project tree, /shared, /library and bound connections, plus the
  // step's own inputs, outputs and workspace. No personal area is nameable.
  for (
    const area of ["work_item", "project", "shared", "library", "connections"]
  ) assert(DEFAULT_STEP_FILES.read.includes(area as never), area);
  // O45: outputs, workspace, the run folder, attachments, assets, workspaces.
  // /shared is not among them: it needs a grant.
  assert(!(DEFAULT_STEP_FILES.write as readonly string[]).includes("shared"));
  assertEquals(readsOnlyInputs(undefined), false);
  assertEquals(readsOnlyInputs({ read: ["inputs"], write: ["outputs"] }), true);
});

Deno.test("contract: an unknown area or an extra key is refused, never dropped", () => {
  assert(
    !WorkflowStepFilesSchema.safeParse({ read: ["users"], write: [] }).success,
  );
  assert(
    !WorkflowStepFilesSchema.safeParse({ read: [], write: ["shared"] }).success,
  );
  assert(
    !WorkflowStepFilesSchema.safeParse({ read: [], write: [], grant: [] })
      .success,
  );
});

Deno.test("contract: sealed is a described boolean naming its expansion", () => {
  const description = WorkflowStepSealedSchema.description ?? "";
  assert(description.length > 80);
  assert(description.includes("[inputs]") && description.includes("[outputs]"));
  assert(description.includes("evaluation"));
  assertEquals(
    { read: [...SEALED_STEP_FILES.read], write: [...SEALED_STEP_FILES.write] },
    { read: ["inputs"], write: ["outputs"] },
  );
});

Deno.test("compiler: sealed: true expands into the files section and nothing else", async () => {
  const result = await compile([step({ sealed: true })]);
  assert(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics));
  const node = result.document.steps[0];
  assert(node && node.kind === "action");
  assertEquals(node.files, { read: ["inputs"], write: ["outputs"] });
  assert(!Object.hasOwn(node, "sealed"));
  const planStep = result.plan.steps[0];
  assert(planStep);
  assertEquals(planStep.files, { read: ["inputs"], write: ["outputs"] });
  assert(!Object.hasOwn(planStep, "sealed"));
  assert(!JSON.stringify(result.plan).includes("sealed"));
  assert(readsOnlyInputs(planStep.files));
  // The claim mints no storage tools for it, as for S2's inputs-only step.
  assertEquals(stepFileScopes(planStep.files!), []);
});

Deno.test("compiler: sealed sugar and its explicit files section share a digest", async () => {
  const sugar = await compile([step({ sealed: true })]);
  const explicit = await compile([
    step({ files: { read: ["inputs"], write: ["outputs"] } }),
  ]);
  const both = await compile([
    step({ sealed: true, files: { write: ["outputs"], read: ["inputs"] } }),
  ]);
  assert(sugar.ok && explicit.ok && both.ok);
  assertEquals(sugar.document, explicit.document);
  assertEquals(sugar.plan, explicit.plan);
  assertEquals(sugar.digest, explicit.digest);
  assertEquals(both.digest, explicit.digest);
});

Deno.test("compiler: sealed: false leaves the defaults and the digest alone", async () => {
  const unsealed = await compile([step({ sealed: false })]);
  const plain = await compile([step()]);
  assert(unsealed.ok && plain.ok);
  assertEquals(unsealed.digest, plain.digest);
  const node = unsealed.document.steps[0];
  assert(node && node.kind === "action");
  assertEquals(node.files, undefined);
  const narrowed = await compile([
    step({ sealed: false, files: { read: ["inputs", "shared"] } }),
  ]);
  assert(narrowed.ok);
  const narrowedNode = narrowed.document.steps[0];
  assert(narrowedNode && narrowedNode.kind === "action");
  assertEquals(narrowedNode.files?.read, ["inputs", "shared"]);
});

/** An evaluation.check step's input, as a batch hands it over. */
const checkInput = {
  evaluationResultId: "0195f000-0000-7000-8000-0000000000f1",
  outputArtifactVersionId: "0195f000-0000-7000-8000-0000000000f2",
  check: { kind: "contains", config: { substring: "ok" } },
};

Deno.test("compiler: an evaluation step is sealed by default (O53)", async () => {
  for (
    const uses of ["evaluation.check", "evaluation.sample", "evaluation.score"]
  ) {
    assert(sealedByDefault(uses), uses);
  }
  for (
    const uses of ["workflow.noop", "harness.implement", "review.independent"]
  ) {
    assert(!sealedByDefault(uses), uses);
  }
  assert(!sealedByDefault("no.such.action"));
  const evaluation = await compile([
    step({ uses: "evaluation.check", with: checkInput }),
  ]);
  assert(
    evaluation.ok,
    JSON.stringify(evaluation.ok ? [] : evaluation.diagnostics),
  );
  const node = evaluation.document.steps[0];
  assert(node && node.kind === "action");
  assertEquals(node.files, { read: ["inputs"], write: ["outputs"] });
  assertEquals(evaluation.plan.steps[0]?.files, {
    read: ["inputs"],
    write: ["outputs"],
  });
  // The default and the explicit sugar are the same plan and digest.
  const sugar = await compile([
    step({ uses: "evaluation.check", with: checkInput, sealed: true }),
  ]);
  assert(sugar.ok);
  assertEquals(sugar.digest, evaluation.digest);
});

Deno.test("compiler: an evaluation step's own files section or sealed: false wins over the default", async () => {
  const opened = await compile([
    step({ uses: "evaluation.check", with: checkInput, sealed: false }),
  ]);
  assert(opened.ok, JSON.stringify(opened.ok ? [] : opened.diagnostics));
  const openedNode = opened.document.steps[0];
  assert(openedNode && openedNode.kind === "action");
  assertEquals(openedNode.files, undefined);
  const explicit = await compile([
    step({
      uses: "evaluation.check",
      with: checkInput,
      files: { read: ["inputs", "shared"], write: ["outputs"] },
    }),
  ]);
  assert(explicit.ok, JSON.stringify(explicit.ok ? [] : explicit.diagnostics));
  const explicitNode = explicit.document.steps[0];
  assert(explicitNode && explicitNode.kind === "action");
  assertEquals(explicitNode.files?.read, ["inputs", "shared"]);
  // Any other step keeps the defaults when it authors neither.
  const plain = await compile([step()]);
  assert(plain.ok);
  const plainNode = plain.document.steps[0];
  assert(plainNode && plainNode.kind === "action");
  assertEquals(plainNode.files, undefined);
});

Deno.test("compiler: sealed with a conflicting files section is refused by name", async () => {
  for (
    const files of [
      { read: ["inputs", "shared"], write: ["outputs"] },
      { read: ["inputs"] },
      { write: ["outputs", "workspace"] },
      { read: [], write: [] },
    ]
  ) {
    const result = await compile([step({ sealed: true, files })]);
    assert(!result.ok, JSON.stringify(files));
    assertEquals(
      result.diagnostics.map((d) => d.code),
      ["action_sealed_conflicts_files"],
      JSON.stringify(files),
    );
  }
  const typed = await compile([step({ sealed: "yes" })]);
  assert(!typed.ok);
  assertEquals(typed.diagnostics.map((d) => d.code), ["action_sealed_invalid"]);
});

Deno.test("compiler: a files section is canonical in the node and carried into the plan", async () => {
  const result = await compile([
    step({ files: { read: ["shared", "inputs"], write: ["outputs"] } }),
  ]);
  assert(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics));
  const node = result.document.steps[0];
  assert(node && node.kind === "action");
  assertEquals(node.files, { read: ["inputs", "shared"], write: ["outputs"] });
  assertEquals(result.plan.steps[0]?.files, node.files);
});

Deno.test("compiler: an axis left out takes its default; no section keeps the digest", async () => {
  const narrowed = await compile([step({ files: { read: ["inputs"] } })]);
  assert(narrowed.ok);
  const node = narrowed.document.steps[0];
  assert(node && node.kind === "action");
  assertEquals(node.files, {
    read: ["inputs"],
    write: [...DEFAULT_STEP_FILES.write],
  });
  const plain = await compile([step()]);
  const again = await compile([step()]);
  assert(plain.ok && again.ok);
  const plainNode = plain.document.steps[0];
  assert(plainNode && plainNode.kind === "action");
  assertEquals(plainNode.files, undefined);
  assertEquals(plain.plan.steps[0]?.files, undefined);
  assertEquals(plain.digest, again.digest);
  assert(plain.digest !== narrowed.digest);
});

Deno.test("compiler: each malformed files section is a named diagnostic", async () => {
  const cases: Array<[unknown, string, string]> = [
    ["everything", "/steps/0/files", "action_files_invalid"],
    [
      { read: ["inputs"], grant: [] },
      "/steps/0/files/grant",
      "action_files_invalid",
    ],
    [{ read: "inputs" }, "/steps/0/files/read", "action_files_invalid"],
    [
      { read: ["inputs", "inputs"] },
      "/steps/0/files/read/1",
      "action_files_invalid",
    ],
    [{ read: ["users"] }, "/steps/0/files/read/0", "action_files_invalid"],
    [
      { write: ["shared"] },
      "/steps/0/files/write/0",
      "action_files_write_needs_grant",
    ],
    [
      { write: ["project"] },
      "/steps/0/files/write/0",
      "action_files_write_needs_grant",
    ],
    [{ write: ["trash"] }, "/steps/0/files/write/0", "action_files_invalid"],
  ];
  for (const [files, path, code] of cases) {
    const result = await compile([step({ files })]);
    assert(!result.ok, JSON.stringify(files));
    assertEquals(
      result.diagnostics.map((entry) => ({
        path: entry.path,
        code: entry.code,
      })),
      [{ path, code }],
      JSON.stringify(files),
    );
  }
});

// ------------------------------------------------- the claim and the scopes

Deno.test("claim: a step with no section gets the undeclared reads; a plan step its own section", async () => {
  assertEquals(
    stepFilesFromSnapshot({ schemaVersion: 1 }, "aa"),
    UNDECLARED_STEP_FILES,
  );
  const result = await compile([
    step({ files: { read: ["inputs"], write: ["outputs"] } }),
    step({ id: "bb", needs: ["aa"] }),
  ]);
  assert(result.ok);
  const snapshot = { runtime: { pin: {}, document: result.document } };
  assertEquals(stepFilesFromSnapshot(snapshot, "aa"), {
    read: ["inputs"],
    write: ["outputs"],
  });
  assertEquals(stepFilesFromSnapshot(snapshot, "bb"), UNDECLARED_STEP_FILES);
  // A step the plan does not name gets the inputs-only section, never the defaults.
  assertEquals(stepFilesFromSnapshot(snapshot, "zz"), INPUTS_ONLY_STEP_FILES);
  assertEquals(
    stepFilesFromSnapshot(snapshot, "Not A Key"),
    INPUTS_ONLY_STEP_FILES,
  );
  assertEquals(
    stepFilesFromSnapshot(
      { runtime: { pin: {}, document: { nope: 1 } } },
      "aa",
    ),
    INPUTS_ONLY_STEP_FILES,
  );
});

Deno.test("claim: no declared section and no grant mints no write tool and no connections read (#448)", async () => {
  const plain = await compile([step({})]);
  assert(plain.ok);
  for (
    const files of [
      stepFilesFromSnapshot({ schemaVersion: 1 }, "aa"),
      stepFilesFromSnapshot(
        { runtime: { pin: {}, document: plain.document } },
        "aa",
      ),
    ]
  ) {
    const scopes = [
      ...grantedScopesForStep(files, []),
      ...stepFileScopes(files),
    ];
    assert(!scopes.includes(FILES_WRITE_SCOPE), JSON.stringify(scopes));
    assert(!scopes.some((scope) => scope.startsWith("files.write:")));
    assert(!scopes.includes("files.read:connections"));
    assert(scopes.includes("files.read:project"));
  }
  // A person's write grant still adds the write tool to an undeclared step.
  assert(
    grantedScopesForStep(UNDECLARED_STEP_FILES, [FILES_WRITE_SCOPE])
      .includes(FILES_WRITE_SCOPE),
  );
  // A definition that declares a tree write area is an explicit grant.
  const declared = await compile([
    step({ files: { read: ["project"], write: ["run_folder"] } }),
  ]);
  assert(declared.ok);
  const declaredScopes = stepFileScopes(
    stepFilesFromSnapshot(
      { runtime: { pin: {}, document: declared.document } },
      "aa",
    ),
  );
  assert(declaredScopes.includes(FILES_WRITE_SCOPE));
  assert(declaredScopes.includes("files.write:run_folder"));
});

Deno.test("scopes: the defaults mint the read and write tools and one scope per tree area", () => {
  const scopes = stepFileScopes(DEFAULT_STEP_FILES);
  assert(scopes.includes(FILES_READ_SCOPE));
  assert(scopes.includes(FILES_WRITE_SCOPE));
  for (
    const area of ["work_item", "project", "shared", "library", "connections"]
  ) assert(scopes.includes("files.read:" + area), area);
  for (const area of ["run_folder", "attachments", "assets", "workspaces"]) {
    assert(scopes.includes("files.write:" + area), area);
  }
  // Inputs, outputs and the workspace are the step's own, not tree areas.
  assert(!scopes.includes("files.read:inputs"));
  assert(!scopes.includes("files.write:outputs"));
  assertEquals([...scopes].sort(), [...scopes]);
});

Deno.test("scopes: an inputs-only step gets no storage tool at all", () => {
  assertEquals(stepFileScopes({ read: ["inputs"], write: ["outputs"] }), []);
  assertEquals(
    stepFileScopes({ read: ["inputs", "shared"], write: ["outputs"] }),
    [FILES_READ_SCOPE, "files.read:shared"],
  );
});

Deno.test("scopes: files.read is never a blanket read every session gets", () => {
  assert(!readScopesForSession().includes(FILES_READ_SCOPE));
});

Deno.test("session: the storage reads are offered under files.read only", () => {
  for (
    const name of [
      "storageRoots.list",
      "storageFolderEntries.list",
      "storageFiles.content",
    ]
  ) {
    assertEquals(
      assertSessionToolAllowed([FILES_READ_SCOPE], name),
      FILES_READ_SCOPE,
    );
    let refused: unknown;
    try {
      assertSessionToolAllowed(readScopesForSession(), name);
    } catch (error) {
      refused = error;
    }
    assert(refused instanceof SessionToolError, name);
    assertEquals(refused.code, "SESSION_TOOL_DENIED");
  }
});

Deno.test("scopes: the declared areas read back into the tree areas they reach", () => {
  const read = declaredTreeAreas(["files.read:work_item"], "read");
  assertEquals(
    [...read].sort(),
    [AgentTreeArea.Attachments, AgentTreeArea.RunFolder, AgentTreeArea.WorkItem]
      .sort(),
  );
  // A write scope never declares a read, and an unknown area reaches nothing.
  assertEquals(declaredTreeAreas(["files.write:attachments"], "read"), []);
  assertEquals(declaredTreeAreas(["files.read:users"], "read"), []);
  assertEquals(declaredTreeAreas(undefined, "read"), []);
});

// ----------------------------------------------------------- the area model

const own = { taskId: TASK, applicationId: APP };
const entry = (
  systemKey: string | null,
  policy: ChainEntry["policy"] = "record",
  ownerId: string | null = null,
): ChainEntry => ({ systemKey, policy, ownerId });

Deno.test("areas: each place in the tree classifies to the area the files section names", () => {
  const projects = entry("projects");
  const project = entry("project:" + APP);
  const artifacts = entry("project:" + APP + ":artifacts");
  const item = entry("task:" + TASK);
  const cases: Array<[ChainEntry[], AgentTreeArea]> = [
    [[entry("trash", "system")], AgentTreeArea.Trash],
    [[entry("system", "system"), entry(null, "system")], AgentTreeArea.System],
    [
      [entry("users", "personal"), entry(null, "personal", PERSON)],
      AgentTreeArea.Personal,
    ],
    [[entry("library", "library")], AgentTreeArea.Library],
    [
      [entry("connections", "working"), entry(null, "working")],
      AgentTreeArea.Connections,
    ],
    [
      [entry("shared", "working"), entry(null, "working")],
      AgentTreeArea.Shared,
    ],
    [[projects], AgentTreeArea.ProjectsRoot],
    [[projects, project], AgentTreeArea.Project],
    [[projects, project, artifacts, item], AgentTreeArea.WorkItem],
    [[
      projects,
      project,
      artifacts,
      item,
      entry("task:" + TASK + ":attachments", "working"),
    ], AgentTreeArea.Attachments],
    [
      [projects, project, artifacts, item, entry("task:" + TASK + ":runs")],
      AgentTreeArea.RunFolder,
    ],
    [
      [projects, project, entry("project:" + APP + ":assets", "working")],
      AgentTreeArea.Assets,
    ],
    [
      [projects, project, entry("project:" + APP + ":workspaces", "working")],
      AgentTreeArea.Workspaces,
    ],
    [[projects, entry("project:" + OTHER_APP)], AgentTreeArea.OtherProject],
    [[entry(null, "working")], AgentTreeArea.Unknown],
  ];
  for (const [chain, area] of cases) {
    assertEquals(agentTreeAreaOf(chain, own), area, area);
  }
});

Deno.test("areas: each read refusal is named", () => {
  const base = {
    declared: [AgentTreeArea.Shared],
    liveGrant: undefined,
    personalOwnerId: null,
  };
  assertEquals(
    agentReadAreaRefusal({ ...base, area: AgentTreeArea.Trash }),
    AgentFileRefusal.TrashArea,
  );
  assertEquals(
    agentReadAreaRefusal({ ...base, area: AgentTreeArea.System }),
    AgentFileRefusal.SystemArea,
  );
  assertEquals(
    agentReadAreaRefusal({
      ...base,
      area: AgentTreeArea.Personal,
      personalOwnerId: PERSON,
    }),
    AgentFileRefusal.PersonalArea,
  );
  assertEquals(
    agentReadAreaRefusal({ ...base, area: AgentTreeArea.Connections }),
    AgentFileRefusal.ConnectionNotBound,
  );
  assertEquals(
    agentReadAreaRefusal({ ...base, area: AgentTreeArea.Library }),
    AgentFileRefusal.AreaNotDeclared,
  );
  assertEquals(
    agentReadAreaRefusal({ ...base, area: AgentTreeArea.Shared }),
    undefined,
  );
});

Deno.test("areas: the roots an agent sees follow its files section, never personal, trash or system", () => {
  const keys = [
    "projects",
    "shared",
    "user:" + PERSON,
    "library",
    "connections",
    "trash",
    "system",
  ];
  assertEquals(
    agentRootKeys(
      keys,
      declaredTreeAreas(stepFileScopes(DEFAULT_STEP_FILES), "read"),
    ),
    [
      "projects",
      "shared",
      "library",
    ],
  );
  assertEquals(
    agentRootKeys(keys, declaredTreeAreas(["files.read:shared"], "read")),
    ["shared"],
  );
  assertEquals(agentRootKeys(keys, []), []);
});

// -------------------------------------------- the real guard, one layer each

type Row = {
  id: string;
  name: string;
  organization_id: string;
  system_key: string | null;
  policy: ChainEntry["policy"];
  owner_id: string | null;
};

const ID = (n: number) =>
  "0195f000-0000-7000-8000-" + String(n).padStart(12, "0");

type ChainSpec =
  | [string, string | null, ChainEntry["policy"]]
  | [string, string | null, ChainEntry["policy"], string | null];

function chainOf(...entries: ChainSpec[]): Row[] {
  return entries.map(([name, systemKey, policy, ownerId], index) => ({
    id: ID(index + 1),
    name,
    organization_id: ORG,
    system_key: systemKey,
    policy,
    owner_id: ownerId ?? null,
  }));
}

function grantRow(
  folder: string,
  grantedBy = ADMIN,
  access: "read" | "write" = "read",
) {
  return {
    id: ID(900),
    organization_id: ORG,
    workflow_id: WORKFLOW,
    folder_id: folder,
    access,
    granted_by: grantedBy,
    expires_at: new Date("2026-11-19T12:05:00Z"),
    revoked_at: null,
  };
}

function fakeTx(chain: Row[], grants: unknown[] = []) {
  return {
    query: <R>(sql: string) =>
      Promise.resolve({
        rows: (sql.includes("with recursive up")
          ? chain
          : sql.includes("agent_file_grants")
          ? grants
          : []) as R[],
        rowCount: 0,
      }),
  } as unknown as Parameters<typeof assertAgentFileRead>[0];
}

function targetOf(chain: Row[]): AgentFileTarget {
  const last = chain.at(-1)!;
  return {
    id: last.id,
    policy: last.policy,
    owner_id: last.owner_id,
    system_key: last.system_key,
  };
}

function readScope(
  chain: Row[],
  scopes: readonly string[] = stepFileScopes(DEFAULT_STEP_FILES),
) {
  return {
    organizationId: ORG,
    principalId: PERSON,
    workflowId: WORKFLOW,
    target: targetOf(chain),
    declared: declaredTreeAreas(scopes, "read"),
    own,
    now: T0,
  };
}

async function readReason(
  chain: Row[],
  grants: unknown[] = [],
  scopes?: readonly string[],
) {
  const error = await assertRejects(() =>
    assertAgentFileRead(fakeTx(chain, grants), readScope(chain, scopes))
  ) as StandardError;
  assert(error instanceof StandardError);
  const params = error.params as { reason?: string } | undefined;
  return params?.reason ?? error.code;
}

const shared = chainOf(["shared", "shared", "working"], [
  "notes.md",
  null,
  "working",
]);
const ownFolder = chainOf(["users", "users", "personal"], [
  "me",
  "user:" + PERSON,
  "personal",
  PERSON,
], ["a.md", null, "personal", PERSON]);
const theirFolder = chainOf(["users", "users", "personal"], [
  "them",
  null,
  "personal",
  OTHER_MEMBER,
]);
const trash = chainOf(["trash", "trash", "system"], [
  "gone.md",
  null,
  "working",
]);
const system = chainOf(["system", "system", "system"], [
  "config",
  null,
  "system",
]);
const connection = chainOf(["connections", "connections", "working"], [
  "drive",
  null,
  "working",
]);
const library = chainOf(["library", "library", "library"], [
  "skill.md",
  null,
  "library",
]);
const otherProject = chainOf(["projects", "projects", "record"], [
  "other",
  "project:" + OTHER_APP,
  "record",
]);
const workItem = chainOf(
  ["projects", "projects", "record"],
  ["app", "project:" + APP, "record"],
  ["artifacts", "project:" + APP + ":artifacts", "record"],
  ["item", "task:" + TASK, "record"],
);

Deno.test("read guard: the defaults open the project tree, /shared and /library", async () => {
  for (const chain of [shared, library, workItem]) {
    await assertAgentFileRead(fakeTx(chain), readScope(chain));
  }
});

Deno.test("read guard: each closed area refuses by name while the other layers hold", async () => {
  assertEquals(await readReason(trash), AgentFileRefusal.TrashArea);
  assertEquals(await readReason(system), AgentFileRefusal.SystemArea);
  // The starter's own folder is closed under the defaults, even to a grant an
  // Admin made: only its owner can open it.
  assertEquals(await readReason(ownFolder), AgentFileRefusal.PersonalArea);
  assertEquals(
    await readReason(ownFolder, [grantRow(ownFolder[1]!.id)]),
    AgentFileRefusal.PersonalArea,
  );
  assertEquals(
    await readReason(connection),
    AgentFileRefusal.ConnectionNotBound,
  );
  assertEquals(
    await readReason(otherProject),
    AgentFileRefusal.AreaNotDeclared,
  );
});

Deno.test("read guard: a inputs-only or narrowed step reaches nothing it did not declare", async () => {
  const inputsOnly = stepFileScopes({ read: ["inputs"], write: ["outputs"] });
  for (const chain of [shared, library, workItem]) {
    assertEquals(
      await readReason(chain, [], inputsOnly),
      AgentFileRefusal.AreaNotDeclared,
    );
  }
  const workItemOnly = stepFileScopes({ read: ["work_item"], write: [] });
  await assertAgentFileRead(
    fakeTx(workItem),
    readScope(workItem, workItemOnly),
  );
  assertEquals(
    await readReason(shared, [], workItemOnly),
    AgentFileRefusal.AreaNotDeclared,
  );
});

Deno.test("read guard: a live grant widens scope, never authority", async () => {
  const inputsOnly = stepFileScopes({ read: ["inputs"], write: ["outputs"] });
  // An Admin's read grant on /shared opens it to an inputs-only step.
  await assertAgentFileRead(
    fakeTx(shared, [grantRow(shared[0]!.id)]),
    readScope(shared, inputsOnly),
  );
  // The owner's own grant opens the starter's folder.
  await assertAgentFileRead(
    fakeTx(ownFolder, [grantRow(ownFolder[1]!.id, PERSON)]),
    readScope(ownFolder),
  );
  // Another member granted their folder: the area opens, the person cannot read it.
  assertEquals(
    await readReason(theirFolder, [grantRow(theirFolder[1]!.id, OTHER_MEMBER)]),
    AgentFileRefusal.PrincipalCannotRead,
  );
  // A grant never opens /trash or /system.
  assertEquals(
    await readReason(trash, [grantRow(trash[0]!.id)]),
    AgentFileRefusal.TrashArea,
  );
});

Deno.test("read guard: a row from another organization is not found", async () => {
  const foreign = shared.map((row, index) =>
    index === 1 ? { ...row, organization_id: OTHER_ORG } : row
  );
  assertEquals(await readReason(foreign), "RESOURCE_NOT_FOUND");
  // An id with no chain at all in this organization.
  const missing = await assertRejects(() =>
    assertAgentFileRead(fakeTx([]), readScope(shared))
  ) as StandardError;
  assertEquals(missing.code, "RESOURCE_NOT_FOUND");
});

// -------------------------------------------- O45 defaults beside #729 grants

function writeScope(
  chain: Row[],
  scopes: readonly string[] = stepFileScopes(DEFAULT_STEP_FILES),
) {
  return {
    organizationId: ORG,
    principalId: PERSON,
    workflowId: WORKFLOW,
    attemptId: ATTEMPT,
    agentSessionId: null,
    target: targetOf(chain),
    access: "write" as const,
    now: T0,
    defaults: { declared: declaredTreeAreas(scopes, "write"), own },
  };
}

async function writeReason(
  chain: Row[],
  grants: unknown[] = [],
  scopes?: readonly string[],
) {
  const error = await assertRejects(() =>
    assertAgentFileWrite(fakeTx(chain, grants), writeScope(chain, scopes))
  ) as StandardError;
  assert(error instanceof StandardError);
  return (error.params as { reason?: string } | undefined)?.reason ??
    error.code;
}

const attachments = [
  ...workItem,
  ...chainOf(["attachments", "task:" + TASK + ":attachments", "working"]).map((
    row,
  ) => ({ ...row, id: ID(50) })),
];
const assets = chainOf(["projects", "projects", "record"], [
  "app",
  "project:" + APP,
  "record",
], ["assets", "project:" + APP + ":assets", "working"]);
const runs = [
  ...workItem,
  ...chainOf(["runs", "task:" + TASK + ":runs", "record"]).map((row) => ({
    ...row,
    id: ID(51),
  })),
];

Deno.test("write defaults: O45 areas of the own work item and project need no grant", async () => {
  for (const chain of [attachments, assets]) {
    const allowed = await assertAgentFileWrite(
      fakeTx(chain),
      writeScope(chain),
    );
    assertEquals(allowed.fileGrantId, null);
  }
});

Deno.test("write defaults: anywhere else still needs a grant, and narrowing removes the default", async () => {
  // /shared is not an O45 area: no grant, no write.
  assertEquals(await writeReason(shared), AgentFileRefusal.GrantMissing);
  // The run folder is a record area: it takes declared outputs, not file writes.
  assertEquals(await writeReason(runs), AgentFileRefusal.RecordArea);
  // write: [outputs] stops side-writes into attachments.
  assertEquals(
    await writeReason(
      attachments,
      [],
      stepFileScopes({ read: [], write: ["outputs"] }),
    ),
    AgentFileRefusal.GrantMissing,
  );
  // A person's grant still widens beyond the defaults, as #729 made it.
  const granted = await assertAgentFileWrite(
    fakeTx(shared, [grantRow(shared[0]!.id, ADMIN, "write")]),
    writeScope(shared),
  );
  assertEquals(granted.fileGrantId, ID(900));
});

Deno.test("write defaults: a default never widens beyond the person", async () => {
  // A personal folder never classifies as a default area, so it stays closed.
  assertEquals(await writeReason(ownFolder), AgentFileRefusal.GrantMissing);
  assertEquals(await writeReason(theirFolder), AgentFileRefusal.GrantMissing);
});

Deno.test("claim: a person's file grant never reopens storage for an inputs-only step", () => {
  const granted = [
    FILES_READ_SCOPE,
    FILES_WRITE_SCOPE,
    `${FILES_READ_SCOPE}:shared`,
    "runs.steer",
  ] as const;
  assertEquals(
    grantedScopesForStep({ read: ["inputs"], write: ["outputs"] }, granted),
    ["runs.steer"],
  );
  assertEquals(
    grantedScopesForStep(DEFAULT_STEP_FILES, granted),
    granted,
  );
});
