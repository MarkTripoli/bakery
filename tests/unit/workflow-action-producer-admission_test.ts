import { assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertWorkflowWorkerContract,
  WORKFLOW_ACTION_METADATA,
  WorkflowActionRegistryError,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  assertActionAgentPolicy,
  assertActionInput,
  workflowActionBinding,
  workflowActionCapabilities,
} from "../../packages/persistence/src/action-admission.ts";
import {
  actionAndInputFromSnapshot,
} from "../../packages/persistence/src/repository-admission.ts";
import { workflowRequiresRepository } from "../../apps/server/src/modules/work/run-steps.ts";

const quality: ("git" | "shell" | "browser")[] = ["git", "shell", "browser"];

Deno.test("resolved action input uses its registered contract, including transport-only builtins", () => {
  assertActionInput("quality.check", {
    repositoryId: crypto.randomUUID(),
    revision: "HEAD",
    checks: ["fmt"],
  });
  assertActionInput("mcp.discover", { connectionId: crypto.randomUUID() });
});

for (
  const [label, input] of [
    ["wrong action", { researchArtifact: crypto.randomUUID() }],
    ["unresolved template", {
      repositoryId: "$task.repositoryId",
      revision: "HEAD",
      checks: ["fmt"],
    }],
    ["unknown field", {
      repositoryId: crypto.randomUUID(),
      revision: "HEAD",
      checks: ["fmt"],
      extra: true,
    }],
    ["injected server context", {
      repositoryId: crypto.randomUUID(),
      revision: "HEAD",
      checks: ["fmt"],
      repositoryProfile: {},
    }],
  ] as const
) {
  Deno.test(`resolved action input rejects ${label} without an assignment envelope`, () => {
    assertThrows(
      () => assertActionInput("quality.check", input),
      StandardError,
      "STATE_CONFLICT",
    );
  });
}

Deno.test("resolved input validation fails closed for an unavailable action", () => {
  assertThrows(
    () => assertActionInput("unknown.action", {}),
    StandardError,
    "STATE_CONFLICT",
  );
});

Deno.test("workflow producer retains registry capabilities when requirements are empty or additive", () => {
  assertEquals(workflowActionCapabilities("quality.check"), quality);
  assertEquals(workflowActionCapabilities("quality.check", []), quality);
  assertEquals(workflowActionCapabilities("quality.check", ["web", "git"]), [
    ...quality,
    "web",
  ]);
});

for (const action of ["unknown.action", "rpi.research", "workflow.noop"]) {
  Deno.test(`workflow producer rejects unavailable or control-only action ${action}`, () => {
    assertThrows(
      () => workflowActionCapabilities(action),
      StandardError,
      "STATE_CONFLICT",
    );
  });
}

for (
  const declared of [
    null,
    "git",
    {},
    ["unknown"],
    ["Git"],
    ["git", "git"],
    Array(101).fill("git"),
  ]
) {
  Deno.test(`workflow producer rejects malformed requirements ${JSON.stringify(declared).slice(0, 60)}`, () => {
    assertThrows(
      () => workflowActionCapabilities("quality.check", declared),
      StandardError,
      "STATE_CONFLICT",
    );
  });
}

Deno.test("existing transport-only builtins retain registered admission without inventing public metadata", () => {
  for (
    const action of [
      "mcp.discover",
      "repository.inspect",
      "secret.identity.read",
    ]
  ) {
    const binding = workflowActionBinding(action);
    assertEquals(binding.registryVersion, null);
    assertEquals(binding.metadata, null);
    assertEquals(binding.capabilities, workflowActionCapabilities(action));
  }
});

Deno.test("nonmodel agent permissions may narrow but never omit required capabilities", () => {
  assertActionAgentPolicy(quality, null);
  assertActionAgentPolicy(quality, { harness: "pi" });
  assertActionAgentPolicy(quality, {
    harness: "pi",
    allowedCapabilities: quality,
  });
  assertThrows(
    () =>
      assertActionAgentPolicy(quality, {
        harness: "pi",
        allowedCapabilities: ["git", "shell"],
      }),
    StandardError,
    "STATE_CONFLICT",
  );
  assertThrows(
    () =>
      assertActionAgentPolicy([...quality, "web"], {
        harness: "pi",
        allowedCapabilities: quality,
      }),
    StandardError,
    "STATE_CONFLICT",
  );
});

Deno.test("model policy requires explicit immutable agent and billing", () => {
  assertThrows(
    () => assertActionAgentPolicy(["model"], null),
    StandardError,
    "STATE_CONFLICT",
  );
  assertThrows(
    () => assertActionAgentPolicy(["model"], { harness: "pi" }),
    StandardError,
    "STATE_CONFLICT",
  );
});

Deno.test("registered git requirements cannot be removed by omitting requires", () => {
  for (
    const step of [
      { id: "quality", uses: "quality.check" },
      { id: "quality", uses: "quality.check", requires: [] },
    ]
  ) {
    assertEquals(workflowRequiresRepository({ steps: [step] }), true);
  }
});

Deno.test("frozen action metadata and version are checked instead of selecting a new default", () => {
  const binding = workflowActionBinding("quality.check", ["web"]);
  const row = {
    stepKey: "quality",
    repositoryId: null,
    stepOutputs: {},
    runSnapshot: {
      workflow: {
        normalizedSpec: {
          steps: [{
            id: "quality",
            uses: "quality.check",
            requires: ["web"],
            with: {},
          }],
        },
      },
      stepActions: { quality: binding },
    },
  };
  assertEquals(binding.registryVersion, 1);
  assertEquals(binding.metadata, WORKFLOW_ACTION_METADATA["quality.check"]);
  assertEquals(actionAndInputFromSnapshot(row).requiredCapabilities, [
    ...quality,
    "web",
  ]);
  for (
    const changed of [
      { ...binding, registryVersion: 2 },
      { ...binding, action: "rpi.design" },
      { ...binding, capabilities: [] },
      { ...binding, metadata: { ...binding.metadata, input: "DesignInput" } },
    ]
  ) {
    assertThrows(
      () =>
        actionAndInputFromSnapshot({
          ...row,
          runSnapshot: {
            ...row.runSnapshot,
            stepActions: { quality: changed },
          },
        }),
      StandardError,
      "STATE_CONFLICT",
    );
  }
});

const metadata = WORKFLOW_ACTION_METADATA["quality.check"];
const contract = {
  inputSchema: metadata.input,
  outputSchema: metadata.output,
  capabilities: metadata.capabilities,
};
Deno.test("existing worker contract agrees with published registry metadata", () => {
  assertWorkflowWorkerContract("quality.check", contract);
});
for (
  const [field, value] of [
    ["inputSchema", "DesignInput"],
    ["outputSchema", "ArtifactOutput"],
    ["capabilities", ["git"]],
    ["capabilities", [...quality, "model"]],
  ] as const
) {
  Deno.test(`worker registration mismatch rejects ${field} ${JSON.stringify(value)}`, () => {
    assertThrows(
      () =>
        assertWorkflowWorkerContract("quality.check", {
          ...contract,
          [field]: value,
        }),
      WorkflowActionRegistryError,
      "Worker contract does not match published action metadata",
    );
  });
}

Deno.test("harness.implement input carries the frozen brief as bounded instructions", () => {
  const repositoryId = crypto.randomUUID();
  const planArtifact = crypto.randomUUID();
  const resolve = (brief: unknown, instructions?: string) =>
    actionAndInputFromSnapshot({
      runSnapshot: {
        inputs: instructions === undefined
          ? { brief }
          : { brief, instructions },
        workflow: {
          normalizedSpec: {
            steps: [{
              id: "implement",
              uses: "harness.implement",
              with: {
                repositoryId: "$task.repositoryId",
                planArtifact: "$step.brief.artifact.versionId",
              },
            }],
          },
        },
      },
      stepKey: "implement",
      stepOutputs: { brief: { artifact: { versionId: planArtifact } } },
      repositoryId,
    }).input as Record<string, unknown>;
  const resolved = resolve({
    title: "Add greeting",
    description: "Write hello.txt",
    taskType: "feature",
  });
  assertEquals(
    resolved.instructions,
    "Task: Add greeting\n\nWrite hello.txt",
  );
  assertActionInput("harness.implement", resolved);
  const long = resolve({ title: "t", description: "x".repeat(9_000) });
  assertEquals((long.instructions as string).length, 4_000);
  assertActionInput("harness.implement", long);
  assertEquals(
    Object.hasOwn(resolve({ title: " ", description: "" }), "instructions"),
    false,
  );
  assertEquals(
    resolve({ title: "Add greeting", description: "" }, "Task: frozen text")
      .instructions,
    "Task: frozen text",
  );
});

Deno.test("brief instructions are cut on a code point, stay within the bound and carry the shared truncation marker", () => {
  const bounded = actionAndInputFromSnapshot({
    runSnapshot: {
      inputs: {
        brief: {
          title: "Multibyte emoji",
          description: "\u{1F600}".repeat(10_000),
        },
      },
      workflow: {
        normalizedSpec: {
          steps: [{
            id: "implement",
            uses: "harness.implement",
            with: {
              repositoryId: "$task.repositoryId",
              planArtifact: "$step.brief.artifact.versionId",
            },
          }],
        },
      },
    },
    stepKey: "implement",
    stepOutputs: {
      brief: { artifact: { versionId: crypto.randomUUID() } },
    },
    repositoryId: crypto.randomUUID(),
  }).input as Record<string, unknown>;
  const text = bounded.instructions as string;
  assertEquals(text.isWellFormed(), true);
  assertEquals(text.length <= 4_000, true);
  assertEquals(text.startsWith("Task: Multibyte emoji\n\n"), true);
  assertEquals(text.endsWith("\n[truncated]"), true);
  assertActionInput("harness.implement", bounded);
});
