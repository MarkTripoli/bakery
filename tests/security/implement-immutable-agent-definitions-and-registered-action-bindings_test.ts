import { assert, assertEquals } from "@std/assert";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { WORKFLOW_ACTION_REGISTRY_VERSION } from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  FIXED_CODING_PRESET,
  renderImplementInstructions,
} from "../../packages/contracts/src/workflow-presets.ts";
import {
  apiCall,
  createCodingAgent,
  createPresetTask,
  expectJson,
  presetBilling,
  presetBudgetEnv,
  presetBudgetPolicy,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";
import { seedProviderPricingSnapshot } from "../helpers/funded-model-job.ts";
import {
  bearerCall,
  createServiceAccount,
  type Json,
  mintToken,
} from "../helpers/access-tokens.ts";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

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
] as const;
const PLANTED = "planted-override-value-7f3a9c";
const BINDING_KEYS = [
  "action",
  "agentVersionId",
  "digest",
  "modelBillingRequired",
  "requiredCapabilities",
  "revision",
  "source",
  "stepId",
];

type Report = {
  valid: boolean;
  errors: { path: string; code: string }[];
  stepBindings?: Json[];
};

function definitionWith(
  bindings: {
    stepAgentVersionId?: string;
    workflowAgentVersionId?: string;
    stepExtra?: Json;
    root?: Json;
  } = {},
): Json {
  const spec = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec)) as Json;
  const implement = (spec.steps as Json[]).find((step) =>
    step.id === "implement"
  )!;
  if (bindings.stepAgentVersionId !== undefined) {
    implement.agentVersionId = bindings.stepAgentVersionId;
  }
  Object.assign(implement, bindings.stepExtra ?? {});
  if (bindings.workflowAgentVersionId !== undefined) {
    spec.agents = { "harness.implement": bindings.workflowAgentVersionId };
  }
  return { ...spec, ...(bindings.root ?? {}) };
}

function client(fixture: WorkerFixture) {
  const call = (
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; ifMatch?: string } = {},
  ) =>
    apiCall(fixture, fixture, method, path, {
      body: options.body,
      headers: options.ifMatch === undefined
        ? undefined
        : { "If-Match": options.ifMatch },
    });
  const validate = async (definition: Json) => {
    const response = await call("POST", "/v1/workflow-validations", {
      body: { definition },
    });
    const text = await response.text();
    assertEquals(response.status, 200, text);
    return { text, report: JSON.parse(text) as Report };
  };
  const draft = async (definition: Json) => {
    const workflow = await expectJson<{ id: string }>(
      await call("POST", "/v1/workflows", {
        body: {
          slug: `sec-${crypto.randomUUID().slice(0, 8)}`,
          name: "Security workflow",
          description: "Synthetic workflow for binding security proofs.",
        },
      }),
      201,
    );
    const created = await expectJson<{ id: string }>(
      await call("POST", `/v1/workflows/${workflow.id}/versions`, {
        body: { definition },
      }),
      201,
    );
    return { workflowId: workflow.id, draftId: created.id };
  };
  const publish = (workflowId: string, draftId: string) =>
    call("POST", `/v1/workflows/${workflowId}/versions/${draftId}/publish`, {
      body: {},
      ifMatch: '"1"',
    });
  return { call, validate, draft, publish };
}

Deno.test("step and workflow agent bindings never leak or cross tenants, and overrides are rejected unechoed", () =>
  withWorkerFixture(async (fixture) => {
    const api = client(fixture);
    const database = fixture.pgDatabase;

    const own = await createCodingAgent(fixture, fixture, "sec-own", {
      harness: "codex",
      billing: presetBilling("sec-own"),
    });
    await seedProviderPricingSnapshot(database, {
      billing: presetBilling("sec-own"),
    });

    // Cross-tenant selector: the id exists, but only in another organization.
    const other = await createWorkerScope(fixture, "sec-other", fixture);
    let foreign: string;
    try {
      foreign = await createCodingAgent(fixture, other, "sec-foreign", {
        harness: "codex",
        billing: presetBilling("sec-foreign"),
      });
      for (
        const [level, definition, path] of [
          [
            "step",
            definitionWith({ stepAgentVersionId: foreign }),
            "/steps/1/agentVersionId",
          ],
          [
            "workflow",
            definitionWith({ workflowAgentVersionId: foreign }),
            "/agents/harness.implement",
          ],
        ] as const
      ) {
        const { text, report } = await api.validate(definition);
        assertEquals(report.valid, false, level);
        assertEquals(report.stepBindings, undefined, level);
        assertEquals(
          report.errors.map(({ path, code }) => ({ path, code })),
          [{ path, code: "agent_version_unavailable" }],
          level,
        );
        assert(!text.includes(foreign), `${level} validate echoes the id`);
        const { workflowId, draftId } = await api.draft(definition);
        const published = await api.publish(workflowId, draftId);
        const publishedText = await published.text();
        assertEquals(published.status, 422, level);
        assert(!publishedText.includes(foreign), `${level} publish echoes`);
        assert(publishedText.includes("agent_version_unavailable"), level);
      }
    } finally {
      await closeWorkerScope(fixture, other);
    }

    // Same organization: each report entry carries exactly the eight keys.
    const same = await api.validate(definitionWith({
      stepAgentVersionId: own,
    }));
    assertEquals(same.report.valid, true, same.text);
    assert(same.report.stepBindings && same.report.stepBindings.length > 0);
    for (const entry of same.report.stepBindings) {
      assertEquals(Object.keys(entry).sort(), BINDING_KEYS);
    }
    assert(contractSchemas.ValidationReport.safeParse(same.report).success);
    for (
      const forbidden of ["model", "billing", "provider", "prompt", "config"]
    ) {
      assert(!same.text.includes(`"${forbidden}":`), forbidden);
    }

    // D6 denylist: step level and root level, every key, value never echoed.
    for (
      const [level, definition, prefix] of [
        [
          "step",
          definitionWith({
            stepExtra: Object.fromEntries(
              OVERRIDE_KEYS.map((key) => [key, PLANTED]),
            ),
          }),
          "/steps/1/",
        ],
        [
          "root",
          definitionWith({
            root: Object.fromEntries(
              OVERRIDE_KEYS.map((key) => [key, PLANTED]),
            ),
          }),
          "/",
        ],
      ] as const
    ) {
      const { text, report } = await api.validate(definition);
      assertEquals(report.valid, false, level);
      assertEquals(
        report.errors.filter((error) =>
          error.code === "step_binding_override_forbidden"
        ).map((error) => error.path).sort(),
        OVERRIDE_KEYS.map((key) => `${prefix}${key}`).sort(),
        level,
      );
      assert(!text.includes(PLANTED), `${level} validate echoes the value`);
      const { workflowId, draftId } = await api.draft(definition);
      const refused = await api.publish(workflowId, draftId);
      const refusedText = await refused.text();
      assertEquals(refused.status, 422, level);
      assert(!refusedText.includes(PLANTED), `${level} publish echoes`);
    }

    // Discovery declarations carry no handler or credential fields.
    const page = await expectJson<{ items: Json[] }>(
      await api.call("GET", "/v1/workflow-actions?limit=100"),
      200,
    );
    for (const declaration of page.items) {
      for (const key of Object.keys(declaration)) {
        assert(
          !/handler|executor|credential|secret|token|password|apikey/i.test(
            key,
          ),
          key,
        );
      }
    }
  }));

Deno.test("a tampered frozen step agent is refused at engine admission and creates no job", () =>
  withWorkerFixture(async (fixture) => {
    const api = client(fixture);
    const database = fixture.pgDatabase;
    const first = await createCodingAgent(fixture, fixture, "tamper-one", {
      harness: "codex",
      billing: presetBilling("tamper-one"),
    });
    await seedProviderPricingSnapshot(database, {
      billing: presetBilling("tamper-one"),
    });
    const secondConfig = {
      harness: "codex",
      billing: presetBilling("tamper-two"),
    };
    await seedProviderPricingSnapshot(database, {
      billing: presetBilling("tamper-two"),
    });
    const agent = await expectJson<{ id: string }>(
      await api.call("POST", "/v1/agents", {
        body: {
          slug: `tamper-${crypto.randomUUID().slice(0, 8)}`,
          name: "Tamper agent",
          description:
            "Second agent holding a valid same-organization version.",
        },
      }),
      201,
    );
    const second = await expectJson<{ id: string }>(
      await api.call("POST", `/v1/agents/${agent.id}/versions`, {
        body: {
          revision: 1,
          config: secondConfig,
          digest: await agentVersionDigest(secondConfig),
        },
      }),
      201,
    );

    const { workflowId, draftId } = await api.draft(
      definitionWith({ stepAgentVersionId: first }),
    );
    const published = await expectJson<{ id: string }>(
      await api.publish(workflowId, draftId),
      200,
    );
    const definition = await expectJson<{ version: number }>(
      await api.call("GET", `/v1/workflows/${workflowId}`),
      200,
    );
    await expectJson(
      await api.call("POST", `/v1/workflows/${workflowId}/activations`, {
        body: { versionId: published.id },
        ifMatch: `"${definition.version}"`,
      }),
      200,
    );
    const repository = await seedPresetRepository(database, fixture);
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<{ id: string; workflowVersionId: string }>(
      await api.call("POST", `/v1/tasks/${task.id}/runs`, {
        body: {
          workflowId,
          executionMode: "repository",
          repositoryProfileId: repository.profileId,
          budgetLimitUsd: "5.00",
          inputs: {
            brief: {
              title: "Add upload retry",
              description: "Retry failed uploads twice.",
              taskType: "feature",
            },
            instructions: renderImplementInstructions({
              title: "Add upload retry",
              description: "Retry failed uploads twice.",
            }),
          },
        },
      }),
      201,
    );

    // Point the frozen snapshot at another valid version of this organization.
    await database.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(
            snapshot, '{stepAgents,implement,agentVersionId}', to_jsonb($3::text)
          )
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, run.id, second.id],
    );

    const engine = createBakeryPostgresWorkflowRepository({
      database,
      maxAttempts: 1,
      budgetPolicy: presetBudgetPolicy,
    });
    const owner = await engine.acquireEngineOwner(
      run.id,
      crypto.randomUUID(),
      60_000,
    );
    assert(owner);
    try {
      const key = (stepKey: string) => ({
        runId: run.id,
        stepKey,
        iteration: 0,
        actionVersion: run.workflowVersionId,
      });
      assert((await engine.admit(key("brief"), owner)).jobId);
      const steps = await database.query<{ id: string; step_key: string }>(
        `select id, step_key from bakery.run_steps
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, run.id],
      );
      await database.query(
        `update bakery.run_steps
            set status = 'completed', output = $3::jsonb, finished_at = now()
          where organization_id = $1 and id = $2`,
        [
          fixture.organizationId,
          steps.rows.find((step) => step.step_key === "brief")!.id,
          JSON.stringify({
            artifact: {
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              sha256: "d".repeat(64),
            },
          }),
        ],
      );
      const failure = await engine.admit(key("implement"), owner).then(
        () => null,
        (error: unknown) => error,
      );
      assert(failure instanceof Error, String(failure));
      assert(
        failure.message.includes("FROZEN_STEP_AGENT_MISMATCH"),
        failure.message,
      );
      const implementStep = steps.rows.find((step) =>
        step.step_key === "implement"
      )!;
      const jobs = await database.query(
        "select 1 from bakery.jobs where organization_id = $1 and run_step_id = $2",
        [fixture.organizationId, implementStep.id],
      );
      assertEquals(jobs.rows.length, 0);
    } finally {
      await engine.releaseEngineOwner(owner);
    }
  }, { env: presetBudgetEnv }));

Deno.test("an access token never reads workflow action discovery", async () => {
  const f = await openInstallationFixture();
  try {
    const account = await createServiceAccount(f, "Discovery bot", "admin");
    const token = await mintToken(f, account.id, ["bakery:read"]);
    for (
      const path of [
        "/v1/workflow-actions",
        `/v1/workflow-actions/harness.implement/versions/${WORKFLOW_ACTION_REGISTRY_VERSION}`,
      ]
    ) {
      const response = await bearerCall(f, "GET", path, token.secret);
      const text = await response.text();
      assertEquals(response.status, 401, text);
      const body = JSON.parse(text) as Json;
      assertEquals(body.code, "AUTH_INVALID");
      assert(contractSchemas.Problem.safeParse(body).success);
      for (
        const leaked of [
          "actionId",
          "harness.implement",
          "capabilities",
          "effectPolicy",
        ]
      ) {
        assert(!text.includes(leaked), `${path} leaks ${leaked}`);
      }
    }
  } finally {
    await f.finish();
  }
});
