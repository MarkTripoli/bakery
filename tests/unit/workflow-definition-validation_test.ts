import { assert, assertEquals, assertFalse } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { WORKFLOW_COMPILER_VERSION } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { strictYaml } from "../fixtures/workflow-compiler/specimen.ts";
import {
  jsonPointerToSegments,
  validateWorkflowBindings,
  validateWorkflowDefinitionStatic,
} from "../../apps/server/src/modules/workflows/validation.ts";
import { AgentVersionCreateConfigSchema } from "../../packages/contracts/src/contracts.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import { extractFixedWorkflowSteps } from "../../apps/server/src/modules/work/run-steps.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

const agentId = "00000000-0000-4000-8000-0000000000a1";

const minimal = {
  kind: "fixed",
  workflow: { kind: "fixed" },
  steps: [
    { id: "brief", uses: "task.brief", with: { brief: "$input.brief" } },
    {
      id: "implement",
      uses: "harness.implement",
      with: { planArtifact: "$step.brief.artifact.versionId" },
    },
  ],
};

function withSteps(steps: unknown, extra: Record<string, unknown> = {}) {
  return { kind: "fixed", steps, ...extra };
}

Deno.test("a valid step agentVersionId selector is accepted", async () => {
  const report = await validateWorkflowDefinitionStatic(
    withSteps([{ id: "ab", uses: "workflow.noop", agentVersionId: agentId }]),
  );
  assert(report.valid);
  assertEquals(report.errors, []);
});

Deno.test("valid minimal spec carries digest, graph and registry identity", async () => {
  const report = await validateWorkflowDefinitionStatic(minimal);
  assert(report.valid);
  assertEquals(report.errors, []);
  assertEquals(
    report.normalizedDigest,
    await sha256Hex(canonicalJson(minimal)),
  );
  assertEquals(report.registryVersion, 1);
  assertEquals(report.requiresRepository, true);
  assertEquals(report.graph, {
    kind: "fixed",
    steps: [
      { id: "brief", uses: "task.brief", requires: [] },
      { id: "implement", uses: "harness.implement", requires: [] },
    ],
  });
  assert(/^[0-9a-f]{64}$/.test(report.registryDigest ?? ""));
  assert(contractSchemas.ValidationReport.safeParse(report).success);
});

Deno.test("invalid spec omits all enrichment", async () => {
  const report = await validateWorkflowDefinitionStatic({ kind: "fixed" });
  assertFalse(report.valid);
  assertEquals(report.normalizedDigest, null);
  for (
    const key of [
      "graph",
      "requiresRepository",
      "registryVersion",
      "registryDigest",
    ]
  ) {
    assertFalse(key in report);
  }
  assert(contractSchemas.ValidationReport.safeParse(report).success);
});

const longSteps = Array.from({ length: 101 }, (_, i) => ({
  id: `step_${i}`,
  uses: "workflow.noop",
}));

const OVERRIDE_KEYS = [
  "billing",
  "model",
  "provider",
  "harness",
  "credentials",
  "credential",
  "apiKey",
  "secret",
  "agentConfig",
  "config",
  "run",
  "script",
  "command",
  "code",
  "env",
  "exec",
  "token",
  "password",
];

const cases: [string, unknown, string, string][] = [
  ["not object", [], "", "definition_not_object"],
  [
    "too large",
    withSteps([{
      id: "ab",
      uses: "workflow.noop",
      with: { x: "x".repeat(100_001) },
    }]),
    "",
    "definition_too_large",
  ],
  [
    "kind other",
    { kind: "graph", steps: [{ id: "ab", uses: "workflow.noop" }] },
    "/kind",
    "workflow_kind_unsupported",
  ],
  [
    "kind missing",
    { steps: [{ id: "ab", uses: "workflow.noop" }] },
    "/kind",
    "workflow_kind_unsupported",
  ],
  ["steps missing", { kind: "fixed" }, "/steps", "steps_required"],
  ["steps empty", withSteps([]), "/steps", "steps_required"],
  ["steps too many", withSteps(longSteps), "/steps", "steps_too_many"],
  ["step not object", withSteps(["x"]), "/steps/0", "step_not_object"],
  [
    "step id invalid",
    withSteps([{ id: "A", uses: "workflow.noop" }]),
    "/steps/0/id",
    "step_id_invalid",
  ],
  [
    "step id duplicate",
    withSteps([{ id: "ab", uses: "workflow.noop" }, {
      id: "ab",
      uses: "workflow.noop",
    }]),
    "/steps/1/id",
    "step_id_duplicate",
  ],
  [
    "action invalid",
    withSteps([{ id: "ab", uses: "Bad" }]),
    "/steps/0/uses",
    "step_action_invalid",
  ],
  [
    "action unknown",
    withSteps([{ id: "ab", uses: "no.such" }]),
    "/steps/0/uses",
    "action_unknown",
  ],
  ...["not-a-uuid", null, {}].map((agentVersionId) =>
    [
      `agent version invalid (${JSON.stringify(agentVersionId)})`,
      withSteps([{ id: "ab", uses: "workflow.noop", agentVersionId }]),
      "/steps/0/agentVersionId",
      "step_agent_version_invalid",
    ] as [string, unknown, string, string]
  ),
  [
    "requires invalid",
    withSteps([{ id: "ab", uses: "workflow.noop", requires: "git" }]),
    "/steps/0/requires",
    "step_requires_invalid",
  ],
  [
    "agents not object",
    withSteps([{ id: "ab", uses: "workflow.noop" }], { agents: [] }),
    "/agents",
    "agents_not_object",
  ],
  [
    "binding action unknown",
    withSteps([{ id: "ab", uses: "workflow.noop" }], {
      agents: { "no.such": agentId },
    }),
    "/agents",
    "agent_binding_action_unknown",
  ],
  [
    "binding id invalid",
    withSteps([{ id: "ab", uses: "workflow.noop" }], {
      agents: { "harness.implement": "nope" },
    }),
    "/agents/harness.implement",
    "agent_binding_id_invalid",
  ],
  ...OVERRIDE_KEYS.flatMap((key) => [
    [
      `override key ${key} on step`,
      withSteps([{ id: "ab", uses: "workflow.noop", [key]: "secret-value" }]),
      `/steps/0/${key}`,
      "step_binding_override_forbidden",
    ] as [string, unknown, string, string],
    [
      `override key ${key} at root`,
      withSteps([{ id: "ab", uses: "workflow.noop" }], {
        [key]: "secret-value",
      }),
      `/${key}`,
      "step_binding_override_forbidden",
    ] as [string, unknown, string, string],
  ]),
  [
    "structure invalid",
    withSteps([{ id: "ab", uses: "workflow.noop", repeat: "x" }]),
    "",
    "workflow_structure_invalid",
  ],
];

for (const [name, definition, path, code] of cases) {
  Deno.test(`error ${code}: ${name}`, async () => {
    const report = await validateWorkflowDefinitionStatic(definition);
    assertFalse(report.valid);
    assert(
      report.errors.some((e) => e.path === path && e.code === code),
      JSON.stringify(report.errors),
    );
  });
}

Deno.test("non-array requires on executable action yields exactly one issue", async () => {
  const report = await validateWorkflowDefinitionStatic(
    withSteps([{ id: "impl", uses: "harness.implement", requires: "git" }]),
  );
  assertFalse(report.valid);
  assertEquals(
    report.errors.filter((e) => e.path === "/steps/0/requires").length,
    1,
    JSON.stringify(report.errors),
  );
});

Deno.test("workflow.noop warns action_not_executable but stays valid", async () => {
  const report = await validateWorkflowDefinitionStatic(
    withSteps([{ id: "ab", uses: "workflow.noop" }]),
  );
  assert(report.valid);
  assertEquals(report.warnings.map((w) => [w.path, w.code]), [
    ["/steps/0/uses", "action_not_executable"],
  ]);
});

Deno.test("model action without a binding warns model_agent_unbound", async () => {
  const report = await validateWorkflowDefinitionStatic(
    withSteps([{ id: "plan", uses: "rpi.plan" }]),
  );
  assert(report.warnings.some((w) => w.code === "model_agent_unbound"));
});

Deno.test("report never echoes submitted values", async () => {
  const sentinel = "SENTINEL-VALUE-xyz";
  const report = await validateWorkflowDefinitionStatic({
    kind: sentinel,
    steps: [{
      id: sentinel,
      uses: sentinel,
      requires: sentinel,
      [sentinel]: 1,
    }],
    agents: { [sentinel]: sentinel },
  });
  assertFalse(JSON.stringify(report).includes(sentinel));
  const bad = await validateWorkflowDefinitionStatic(sentinel);
  assertFalse(JSON.stringify(bad).includes(sentinel));
});

Deno.test("parity: statically valid fixtures pass the admission extractor", async () => {
  const fixtures = [
    minimal,
    FIXED_CODING_PRESET.spec,
    {
      kind: "workflow",
      workflow: { kind: "fixed" },
      steps: [{ id: "ab", uses: "workflow.noop" }],
    },
    withSteps([{ id: "ab", uses: "quality.check", requires: ["git"] }]),
  ];
  for (const fixture of fixtures) {
    const report = await validateWorkflowDefinitionStatic(fixture);
    assert(report.valid, JSON.stringify(report.errors));
    extractFixedWorkflowSteps(fixture);
  }
  assertEquals(
    (await validateWorkflowDefinitionStatic(FIXED_CODING_PRESET.spec))
      .normalizedDigest,
    FIXED_CODING_PRESET.digest,
  );
});

Deno.test("jsonPointerToSegments converts pointers to segment arrays", () => {
  assertEquals(jsonPointerToSegments(""), []);
  assertEquals(jsonPointerToSegments("/steps/3/uses"), ["steps", 3, "uses"]);
  assertEquals(jsonPointerToSegments("/agents/a~1b~0c"), ["agents", "a/b~c"]);
});

Deno.test("requires values admission rejects are step_requires_invalid", async () => {
  for (const requires of [["bogus"], ["git", "git"]]) {
    const report = await validateWorkflowDefinitionStatic(
      withSteps([{ id: "impl", uses: "harness.implement", requires }]),
    );
    assertFalse(report.valid);
    assert(
      report.errors.some((e) =>
        e.path === "/steps/0/requires" && e.code === "step_requires_invalid"
      ),
    );
  }
});

async function bindingTransaction(
  allowedCapabilities: readonly string[],
  options: { billing?: boolean } = {},
): Promise<PgTransactionClient> {
  const config = AgentVersionCreateConfigSchema.parse({
    harness: "codex",
    allowedCapabilities,
    ...(options.billing === false ? {} : {
      billing: {
        provider: "preset-provider",
        billingAccountId: "preset-account",
        model: "preset-model",
        billingRoute: "api",
        maxTokens: 1_000,
        maxUsdReservation: 1,
        pricingMetadataSnapshot: "preset-price",
      },
    }),
  });
  const row = {
    id: agentId,
    revision: 1,
    config,
    digest: await sha256Hex(canonicalJson(config)),
    agent_enabled: true,
  };
  return {
    query: () => Promise.resolve({ rows: [row], rowCount: 1 }),
  } as unknown as PgTransactionClient;
}

Deno.test("binding policy denial is reported at the agent and at the failing step requires", async () => {
  const transaction = await bindingTransaction([
    "git",
    "shell",
    "web",
    "model",
  ]);
  const { errors: issues } = await validateWorkflowBindings(
    transaction,
    "00000000-0000-4000-8000-0000000000b1",
    {
      kind: "fixed",
      steps: [
        { id: "first", uses: "harness.implement" },
        { id: "second", uses: "harness.implement", requires: ["browser"] },
        { id: "third", uses: "harness.implement" },
      ],
      agents: { "harness.implement": agentId },
    },
  );
  assertEquals(
    issues.map(({ path, code }) => ({ path, code })),
    [
      {
        path: "/agents/harness.implement",
        code: "agent_action_capability_denied",
      },
      { path: "/steps/1/requires", code: "agent_action_capability_denied" },
    ],
  );
});

Deno.test("binding policy that admits every step reports nothing", async () => {
  const transaction = await bindingTransaction([
    "git",
    "shell",
    "web",
    "model",
    "browser",
  ]);
  const { errors: issues } = await validateWorkflowBindings(
    transaction,
    "00000000-0000-4000-8000-0000000000b1",
    {
      kind: "fixed",
      steps: [
        { id: "first", uses: "harness.implement" },
        { id: "second", uses: "harness.implement", requires: ["browser"] },
      ],
      agents: { "harness.implement": agentId },
    },
  );
  assertEquals(issues, []);
});

Deno.test("each failing step of one action reports its own policy code", async () => {
  // quality.check needs no model; the agent allows its registry set only and
  // has no billing. Step 0 adds a denied capability, step 1 adds model.
  const transaction = await bindingTransaction(["git", "shell", "browser"], {
    billing: false,
  });
  const { errors: issues } = await validateWorkflowBindings(
    transaction,
    "00000000-0000-4000-8000-0000000000b1",
    {
      kind: "fixed",
      steps: [
        { id: "first", uses: "quality.check", requires: ["web"] },
        { id: "second", uses: "quality.check", requires: ["model"] },
        { id: "third", uses: "quality.check" },
      ],
      agents: { "quality.check": agentId },
    },
  );
  assertEquals(
    issues.map(({ path, code }) => ({ path, code })),
    [
      { path: "/agents/quality.check", code: "agent_action_capability_denied" },
      { path: "/steps/0/requires", code: "agent_action_capability_denied" },
      { path: "/steps/1/requires", code: "model_billing_required" },
    ],
  );
});

const compilerDoc = {
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "noop-flow",
  description: "Single no-op step.",
  steps: [{ id: "first", uses: "workflow.noop", with: {} }],
};

Deno.test("validate report carries compiler version and semantic digest for a compilable workflow", async () => {
  const report = await validateWorkflowDefinitionStatic(compilerDoc);
  assertEquals(report.compilerDiagnostics, []);
  assertEquals(report.compilerVersion, WORKFLOW_COMPILER_VERSION);
  assert(/^[0-9a-f]{64}$/.test(report.semanticDigest ?? ""));
});

Deno.test("validate report returns stable pointer diagnostics for an invalid workflow", async () => {
  const bad = {
    ...compilerDoc,
    steps: [
      { id: "first", uses: "workflow.noop", with: {} },
      { id: "first", uses: "workflow.noop", with: {} },
    ],
  };
  const report = await validateWorkflowDefinitionStatic(bad);
  assertEquals(report.semanticDigest, null);
  assertEquals(report.compilerDiagnostics.map((d) => [d.path, d.code]), [
    ["/steps/1/id", "node_id_duplicate"],
  ]);
  const again = await validateWorkflowDefinitionStatic(bad);
  assertEquals(again.compilerDiagnostics, report.compilerDiagnostics);
});

Deno.test("semantic digest ignores JSON vs YAML formatting and key order", async () => {
  const yamlText = [
    "name: noop-flow",
    "description: Single no-op step.",
    "kind: workflow",
    "apiVersion: bakery.dev/v1",
    "steps:",
    "  - {id: first, uses: workflow.noop, with: {}}",
    "",
  ].join("\n");
  const fromYaml = await validateWorkflowDefinitionStatic(
    strictYaml(yamlText),
  );
  const fromJson = await validateWorkflowDefinitionStatic(
    JSON.parse(JSON.stringify(compilerDoc, null, 4)),
  );
  assert(fromJson.semanticDigest !== null);
  assertEquals(fromYaml.semanticDigest, fromJson.semanticDigest);
});

Deno.test("an execution-affecting edit changes the semantic digest", async () => {
  const base = await validateWorkflowDefinitionStatic(compilerDoc);
  const edited = await validateWorkflowDefinitionStatic({
    ...compilerDoc,
    steps: [{ id: "second", uses: "workflow.noop", with: {} }],
  });
  assert(edited.semanticDigest !== null);
  assert(edited.semanticDigest !== base.semanticDigest);
});

Deno.test("a secret reference is rejected without echoing its value", async () => {
  const secret = "$secret.sk_live_TOPSECRETVALUE";
  const report = await validateWorkflowDefinitionStatic({
    ...compilerDoc,
    steps: [{ id: "first", uses: "workflow.noop", with: { token: secret } }],
  });
  assertEquals(report.semanticDigest, null);
  assert(report.compilerDiagnostics.length > 0);
  assertFalse(JSON.stringify(report).includes("TOPSECRETVALUE"));
});
