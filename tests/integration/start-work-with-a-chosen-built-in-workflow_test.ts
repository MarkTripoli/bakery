import {
  isLegacyPresetPin,
  type TicketPin,
} from "../../packages/contracts/src/ticket-admission.ts";
import { assert, assertEquals } from "@std/assert";
import { publishWrittenWorkflow } from "../helpers/ticket-admission/written-workflow.ts";
import { withAutomation } from "../helpers/ticket-admission/automation-fixtures.ts";
import {
  automaticPolicy,
  EXECUTE_LABEL,
  recordOpenIssues,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { processAutomationRoute } from "../../apps/server/src/modules/workflows/automations/event-intake.ts";
import {
  read,
  ticketCall,
  type TicketView,
} from "../helpers/ticket-admission/operations-http.ts";

/**
 * Issue 61: a person's Start work can name a built-in workflow for one issue,
 * and a source policy can name either built-in workflow. The request pins it,
 * the run starts it, and the request view says which one and its revision.
 */

function pinnedWorkflowId(pin: TicketPin | null): string | null {
  return pin === null || isLegacyPresetPin(pin) ? null : pin.workflowId;
}

type Created = {
  id: string;
  disposition: string;
  workflowRunId: string | null;
  pinnedPreset: { workflowId: string; versionId: string; digest: string };
};
type View = { id: string; presetId: string; presetRevision: number };

async function ticketByNumber(
  fx: TicketFixture,
  number: number,
): Promise<TicketView> {
  const page = await read<{ items: TicketView[] }>(
    await ticketCall(fx, "GET", "/v1/external-tickets"),
    200,
  );
  const found = page.items.find((item) => item.number === String(number));
  if (!found) throw new Error(`no ticket ${number}`);
  return found;
}

async function runVersion(fx: TicketFixture, runId: string): Promise<string> {
  const result = await fx.owner.query<{ workflow_version_id: string }>(
    `select workflow_version_id from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [fx.organizationId, runId],
  );
  return result.rows[0]?.workflow_version_id ?? "none";
}

async function runsOfOrganization(fx: TicketFixture): Promise<number> {
  const result = await fx.owner.query<{ count: string }>(
    `select count(*)::text as count from bakery.workflow_runs
      where organization_id = $1`,
    [fx.organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function firingsOfOrganization(fx: TicketFixture): Promise<number> {
  const result = await fx.owner.query<{ count: string }>(
    `select count(*)::text as count from bakery.workflow_start_firings
      where organization_id = $1`,
    [fx.organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** The preset a run's workflow version was materialized from. */
async function runPreset(fx: TicketFixture, runId: string): Promise<string> {
  const result = await fx.owner.query<{ slug: string }>(
    `select definition.slug
       from bakery.workflow_runs run
       join bakery.workflow_versions version
         on version.organization_id = run.organization_id
        and version.id = run.workflow_version_id
       join bakery.workflow_definitions definition
         on definition.organization_id = version.organization_id
        and definition.id = version.workflow_id
      where run.organization_id = $1 and run.id = $2`,
    [fx.organizationId, runId],
  );
  return result.rows[0]?.slug ?? "none";
}

Deno.test("issue 61: Start work judges and pins the built-in workflow a person chose for that issue", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    for (const number of [1, 2]) {
      fx.reader.setIssue({ number, labels: [] });
      fx.facts.set(number, `2026-06-01T00:00:0${number}Z`);
    }
    await recordOpenIssues(fx, sourceId);
    const start = async (number: number, preset: string) => {
      const ticket = await ticketByNumber(fx, number);
      return await ticketCall(
        fx,
        "POST",
        `/v1/external-tickets/${ticket.id}/requests`,
        {
          body: {
            intent: "start",
            expectedSourcePolicyRevision: 1,
            requirementsDigest: ticket.requirementsDigest,
            preset,
          },
        },
      );
    };
    // The reviewed workflow needs review and repair agents this repository
    // does not bind, so choosing it is judged on its own setup and refused.
    const reviewed = await start(1, "fixed-coding-reviewed");
    assertEquals(reviewed.status, 409, await reviewed.clone().text());
    const problem = await reviewed.json() as {
      reason: string;
      issues: { code: string }[];
    };
    assertEquals(problem.reason, "ticket_not_ready");
    assertEquals(problem.issues.map((issue) => issue.code), [
      "preset_setup_required",
    ]);
    assertEquals((await fx.counts(sourceId)).requests, 0);

    // The standard one named explicitly is pinned and run.
    const standard = await read<Created>(await start(2, "fixed-coding"), 201);
    assertEquals(
      standard.pinnedPreset.workflowId,
      fx.builtInWorkflow("fixed-coding").workflowId,
    );
    assertEquals(
      await runVersion(fx, standard.workflowRunId!),
      standard.pinnedPreset.versionId,
    );
    assertEquals(
      await runPreset(fx, standard.workflowRunId!),
      "preset:fixed-coding",
    );
    // The request view names the pinned workflow and its revision.
    const view = await read<View>(
      await ticketCall(fx, "GET", `/v1/ticket-requests/${standard.id}`),
      200,
    );
    assertEquals(
      [view.presetId, view.presetRevision],
      ["fixed-coding", FIXED_CODING_PRESET.revision],
    );
    // A name outside the built-in set is refused before anything is written.
    const refused = await start(1, "other-preset");
    assertEquals(refused.status, 400, await refused.clone().text());
    assertEquals(
      ((await refused.json()) as { issues: { path: string[] }[] }).issues[0]
        .path,
      ["preset"],
    );
    assertEquals((await fx.counts(sourceId)).requests, 1);
  }, { budget: true }));

Deno.test("issue 61: a source policy's built-in workflow is the one admission judges", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: {
        ...fx.policy(),
        workflow: fx.builtInWorkflow("fixed-coding-reviewed"),
      },
    });
    fx.reader.setIssue({ number: 615, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 615, intent: "start" });
    assertEquals(admitted.request, null);
    const check = admitted.report.checks.find((entry) =>
      entry.id === "preset_ready"
    )!;
    assertEquals(
      [check.status, check.reason, check.evidence[0].ref],
      [
        "wait",
        "preset_setup_required",
        `workflow:${fx.builtInWorkflow("fixed-coding-reviewed").workflowId}`,
      ],
    );
    assertEquals(
      pinnedWorkflowId(admitted.report.preset),
      fx.builtInWorkflow("fixed-coding-reviewed").workflowId,
    );
  }, { budget: true }));

Deno.test("issue 61: a ready reviewed workflow is admitted and its run is that workflow", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: {
        ...fx.policy(),
        workflow: fx.builtInWorkflow("fixed-coding-reviewed"),
      },
    });
    fx.reader.setIssue({ number: 616, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 616, intent: "start" });
    const request = admitted.request;
    assert(request, JSON.stringify(admitted.report.checks));
    assertEquals(
      pinnedWorkflowId(admitted.report.preset),
      fx.builtInWorkflow("fixed-coding-reviewed").workflowId,
    );
    const run = await fx.owner.query<{ workflow_run_id: string | null }>(
      `select workflow_run_id from bakery.ticket_requests where id = $1`,
      [request.id],
    );
    const runId = run.rows[0]?.workflow_run_id;
    assert(runId, "the admitted request started a run");
    assertEquals(await runPreset(fx, runId), "preset:fixed-coding-reviewed");
  }, { budget: true, reviewed: true }));

Deno.test("issue 407: starts on the source's workflow are left to the ticket source, which fires them only for an issue it did not admit", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const workflow = fx.builtInWorkflow("fixed-coding");
    const active = await fx.owner.query<{ active_version_id: string }>(
      `select active_version_id from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [fx.organizationId, workflow.workflowId],
    );
    const versionId = active.rows[0].active_version_id;
    await fx.owner.query(
      `update bakery.workflow_versions set starts = $3::jsonb
        where organization_id = $1 and id = $2`,
      [
        fx.organizationId,
        versionId,
        JSON.stringify(["labeled", "opened"].map((action) => ({
          id: `on-${action}`,
          budgetUsd: 5,
          inputs: {},
          on: { kind: "event", eventKind: `work_item.${action}`, filter: {} },
        }))),
      ],
    );
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    a.seedLabeler();
    const automationSide = async (routes: Record<string, string>) => {
      const settled = await processAutomationRoute(
        fx.runtime,
        routes.automation,
      );
      assert(settled.kind === "settled", JSON.stringify(settled));
      return settled.starts;
    };
    const before = await runsOfOrganization(fx);

    a.issue(617);
    const admittedRoutes = await a.deliverRoutes(617);
    assertEquals(
      (await automationSide(admittedRoutes)).map((
        outcome,
      ) => [outcome.startId, outcome.result]),
      [["on-labeled", "left_to_ticket_source"]],
    );
    const admitted = await a.intake(admittedRoutes.fact_refresh);
    assert(admitted.kind === "processed", JSON.stringify(admitted));
    assertEquals(admitted.sources[0].admission, "admitted");
    assertEquals(await firingsOfOrganization(fx), 0);
    assertEquals(await runsOfOrganization(fx), before + 1, "one run for 617");

    a.issue(620);
    const openedRoutes = await a.deliverRoutes(620, "opened");
    assertEquals(
      (await automationSide(openedRoutes)).map((outcome) => outcome.result),
      ["left_to_ticket_source"],
    );
    const opened = await a.intake(openedRoutes.fact_refresh);
    assert(opened.kind === "processed", JSON.stringify(opened));
    assertEquals(opened.sources[0].admission, "admitted");
    assertEquals(await firingsOfOrganization(fx), 0);
    assertEquals(await runsOfOrganization(fx), before + 2, "one run for 620");

    a.issue(999, ["triage"]);
    const unrelatedRoutes = await a.deliverRoutes(999);
    assertEquals(
      (await automationSide(unrelatedRoutes)).map((outcome) => outcome.result),
      ["left_to_ticket_source"],
    );
    const unrelated = await a.intake(unrelatedRoutes.fact_refresh);
    assert(unrelated.kind === "processed", JSON.stringify(unrelated));
    assertEquals(unrelated.sources[0].action, "none");
    assertEquals(await firingsOfOrganization(fx), 1, "999's start fired");
    await a.intake(unrelatedRoutes.fact_refresh);
    assertEquals(await firingsOfOrganization(fx), 1, "a replay fires nothing");
    assertEquals((await fx.counts(sourceId)).requests, 2);
  }));

Deno.test("issue 407: a request pinned before policy v2 keeps its old pin and starts one run of that built-in", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource();
    fx.reader.setIssue({ number: 618, labels: [EXECUTE_LABEL] });
    const planned = await fx.admit(sourceId, { number: 618, intent: "plan" });
    const request = planned.request;
    assert(request, JSON.stringify(planned.report.checks));
    assertEquals(request.workflowRunId, null);
    const legacy = {
      id: "fixed-coding" as const,
      revision: FIXED_CODING_PRESET.revision,
      digest: FIXED_CODING_PRESET.digest,
    };
    await fx.owner.query(
      `update bakery.ticket_requests set pinned_preset = $3::jsonb
        where organization_id = $1 and id = $2`,
      [fx.organizationId, request.id, JSON.stringify(legacy)],
    );
    const before = await runsOfOrganization(fx);

    const started = await fx.admit(sourceId, { number: 618, intent: "start" });
    assertEquals(started.kind, "upgraded", JSON.stringify(started.report));
    assertEquals(started.request?.pinnedPreset, legacy);
    assertEquals(
      pinnedWorkflowId(started.report.preset),
      fx.builtInWorkflow("fixed-coding").workflowId,
      "readiness judges the built-in the old pin names",
    );
    assertEquals(await runsOfOrganization(fx), before + 1, "exactly one run");
    const runId = started.request?.workflowRunId;
    assert(runId, "the upgraded request started a run");
    assertEquals(await runPreset(fx, runId), "preset:fixed-coding");
    const stored = await fx.owner.query<{ pinned_preset: unknown }>(
      `select pinned_preset from bakery.ticket_requests where id = $1`,
      [request.id],
    );
    assertEquals(
      stored.rows[0]?.pinned_preset,
      legacy,
      "the pin is not rewritten",
    );
  }, { budget: true }));

Deno.test("issue 407: a run started by a built-in's version id with inputs answers as on main", () =>
  withTicketFixture(async (fx) => {
    const task = await read<{ id: string }>(
      await ticketCall(fx, "POST", "/v1/tasks", {
        body: {
          applicationId: fx.applicationId,
          repositoryId: fx.repositoryId,
          taskType: "feature",
          title: "Run a built-in by its version",
          description: "A direct run of a built-in workflow version.",
        },
      }),
      201,
    );
    const active = await fx.owner.query<{ active_version_id: string }>(
      `select active_version_id from bakery.workflow_definitions
        where organization_id = $1 and id = $2`,
      [fx.organizationId, fx.builtInWorkflow("fixed-coding").workflowId],
    );
    const response = await ticketCall(
      fx,
      "POST",
      `/v1/tasks/${task.id}/runs`,
      {
        body: {
          workflowVersionId: active.rows[0].active_version_id,
          executionMode: "repository",
          inputs: {},
        },
      },
    );
    const text = await response.text();
    assertEquals(response.status, 422, text);
    assert(!text.includes("inputs_not_allowed_with_preset"), text);
  }, { budget: true }));

Deno.test("issue 407: a written workflow that needs an input is flagged, is refused as a source's workflow, and leaves readiness waiting", () =>
  withTicketFixture(async (fx) => {
    const needs = await publishWrittenWorkflow(fx, "needs-a-note", {
      requiredInput: true,
    });
    const plain = await publishWrittenWorkflow(fx, "plain-written");
    const listed = await read<
      { items: { id: string; needsInputs: boolean }[] }
    >(await ticketCall(fx, "GET", "/v1/workflows?limit=100"), 200);
    const flag = (id: string) =>
      listed.items.find((item) => item.id === id)?.needsInputs;
    assertEquals([flag(needs.workflowId), flag(plain.workflowId)], [
      true,
      false,
    ]);

    const sourceId = await fx.insertSource();
    const refused = await ticketCall(
      fx,
      "PATCH",
      `/v1/ticket-sources/${sourceId}`,
      {
        ifMatch: 1,
        body: {
          policy: {
            ...fx.policy(),
            workflow: { workflowId: needs.workflowId },
          },
        },
      },
    );
    const text = await refused.text();
    assertEquals(refused.status, 422, text);
    assert(text.includes("workflow_needs_inputs"), text);

    await fx.owner.query(
      `update bakery.ticket_sources set policy = $2::jsonb where id = $1`,
      [
        sourceId,
        JSON.stringify({
          ...fx.policy(),
          workflow: { workflowId: needs.workflowId },
        }),
      ],
    );
    fx.reader.setIssue({ number: 640, labels: [EXECUTE_LABEL] });
    const waiting = await fx.admit(sourceId, { number: 640, intent: "start" });
    assertEquals(waiting.request, null);
    const check = waiting.report.checks.find((entry) =>
      entry.id === "preset_ready"
    )!;
    assertEquals([check.status, check.reason], [
      "wait",
      "preset_setup_required",
    ]);
  }, { budget: true }));

Deno.test("issue 407: a source naming a written workflow admits an issue on that workflow's version", () =>
  withTicketFixture(async (fx) => {
    const written = await publishWrittenWorkflow(fx, "written-start");
    const sourceId = await fx.insertSource({
      policy: { ...fx.policy(), workflow: { workflowId: written.workflowId } },
    });
    fx.reader.setIssue({ number: 641, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 641, intent: "start" });
    const request = admitted.request;
    assert(request, JSON.stringify(admitted.report.checks));
    assertEquals(
      [
        (request.pinnedPreset as { workflowId: string }).workflowId,
        (request.pinnedPreset as { versionId: string }).versionId,
      ],
      [written.workflowId, written.versionId],
    );
    assertEquals(
      await runVersion(fx, request.workflowRunId!),
      written.versionId,
    );
  }, { budget: true }));
