import {
  isLegacyPresetPin,
  type TicketPin,
} from "../../packages/contracts/src/ticket-admission.ts";
import { assert, assertEquals } from "@std/assert";
import {
  activateVersion,
  publishVersion,
  publishWrittenWorkflow,
} from "../helpers/ticket-admission/written-workflow.ts";
import {
  seedFact,
  withAutomation,
} from "../helpers/ticket-admission/automation-fixtures.ts";
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

Deno.test("issue 407: a source with automatic admission cannot name a workflow whose starts answer the events admission acts on", () =>
  withTicketFixture(async (fx) => {
    const labeled = await publishWrittenWorkflow(fx, "fires-on-label", {
      startsOn: ["labeled"],
    });
    const closing = await publishWrittenWorkflow(fx, "fires-on-close", {
      startsOn: ["closed"],
    });
    const listed = await read<
      { items: { id: string; startsOverlapAdmission: boolean }[] }
    >(await ticketCall(fx, "GET", "/v1/workflows?limit=100"), 200);
    const flag = (id: string) =>
      listed.items.find((item) => item.id === id)?.startsOverlapAdmission;
    assertEquals([flag(labeled.workflowId), flag(closing.workflowId)], [
      true,
      false,
    ]);
    const sourceId = await fx.insertSource();
    const save = (workflowId: string, automatic: boolean, ifMatch: number) =>
      ticketCall(fx, "PATCH", `/v1/ticket-sources/${sourceId}`, {
        ifMatch,
        body: {
          policy: {
            ...(automatic ? automaticPolicy(fx) : fx.policy()),
            workflow: { workflowId },
          },
        },
      });
    const refused = await save(labeled.workflowId, true, 1);
    const text = await refused.text();
    assertEquals(refused.status, 422, text);
    assert(text.includes("ticket_source_workflow_starts_overlap"), text);
    await read(await save(labeled.workflowId, false, 1), 200);
    await read(await save(closing.workflowId, true, 2), 200);
  }, { budget: true }));

Deno.test("issue 407: using an older version that starts on a label is refused while an automatic source names the workflow", () =>
  withTicketFixture(async (fx) => {
    const written = await publishWrittenWorkflow(fx, "older-label", {
      startsOn: ["opened", "labeled"],
    });
    const plain = await publishVersion(fx, written.workflowId);
    await read(await activateVersion(fx, written.workflowId, plain), 200);
    const sourceId = await fx.insertSource();
    await read(
      await ticketCall(fx, "PATCH", `/v1/ticket-sources/${sourceId}`, {
        ifMatch: 1,
        body: {
          policy: {
            ...automaticPolicy(fx),
            workflow: { workflowId: written.workflowId },
          },
        },
      }),
      200,
    );
    const refused = await activateVersion(
      fx,
      written.workflowId,
      written.versionId,
    );
    const text = await refused.text();
    assertEquals(refused.status, 422, text);
    assert(text.includes("ticket_source_workflow_starts_overlap"), text);
    const still = await read<{ activeVersionId: string }>(
      await ticketCall(fx, "GET", `/v1/workflows/${written.workflowId}`),
      200,
    );
    assertEquals(still.activeVersionId, plain);
  }, { budget: true }));

Deno.test("issue 407: enabling a workflow whose version in use starts on a label is refused while an automatic source names it", () =>
  withTicketFixture(async (fx) => {
    const written = await publishWrittenWorkflow(fx, "enable-label", {
      startsOn: ["labeled"],
    });
    const current = await read<{ version: number }>(
      await ticketCall(fx, "PATCH", `/v1/workflows/${written.workflowId}`, {
        ifMatch: (await read<{ version: number }>(
          await ticketCall(fx, "GET", `/v1/workflows/${written.workflowId}`),
          200,
        )).version,
        body: { enabled: false },
      }),
      200,
    );
    await fx.insertSource({
      policy: {
        ...automaticPolicy(fx),
        workflow: { workflowId: written.workflowId },
      },
    });
    const refused = await ticketCall(
      fx,
      "PATCH",
      `/v1/workflows/${written.workflowId}`,
      { ifMatch: current.version, body: { enabled: true } },
    );
    const text = await refused.text();
    assertEquals(refused.status, 422, text);
    assert(text.includes("ticket_source_workflow_starts_overlap"), text);
  }, { budget: true }));

Deno.test("issue 407: closing an issue the source admitted fires the workflow's closed start once", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const written = await publishWrittenWorkflow(fx, "fires-on-close", {
      startsOn: ["closed"],
    });
    const sourceId = await fx.insertSource({
      policy: {
        ...automaticPolicy(fx),
        workflow: { workflowId: written.workflowId },
      },
    });
    a.seedLabeler();
    a.issue(617);
    const labelled = await a.deliverRoutes(617);
    await processAutomationRoute(fx.runtime, labelled.automation);
    const admitted = await a.intake(labelled.fact_refresh);
    assert(admitted.kind === "processed", JSON.stringify(admitted));
    assertEquals(admitted.sources[0].admission, "admitted");
    assertEquals(await firingsOfOrganization(fx), 0);
    a.edit(617, { state: "closed" });
    const closed = await a.deliverRoutes(617, "closed");
    const side = await processAutomationRoute(fx.runtime, closed.automation);
    assert(side.kind === "settled", JSON.stringify(side));
    assertEquals(side.starts.map((outcome) => outcome.result), ["started"]);
    await a.intake(closed.fact_refresh);
    assertEquals(await firingsOfOrganization(fx), 1);
    await processAutomationRoute(fx.runtime, closed.automation);
    assertEquals(await firingsOfOrganization(fx), 1, "a replay fires nothing");
    assertEquals((await fx.counts(sourceId)).requests, 1);
  }));

Deno.test("issue 407: a failed issue read on delivery, then a poll, starts exactly one run", () =>
  withAutomation(async (a) => {
    const { fx } = a;
    const overlapping = await publishWrittenWorkflow(fx, "probe-label", {
      startsOn: ["labeled"],
    });
    const written = await publishWrittenWorkflow(fx, "probe-plain");
    const sourceId = await fx.insertSource();
    const save = (workflowId: string) =>
      ticketCall(fx, "PATCH", `/v1/ticket-sources/${sourceId}`, {
        ifMatch: 1,
        body: { policy: { ...automaticPolicy(fx), workflow: { workflowId } } },
      });
    const refused = await save(overlapping.workflowId);
    const text = await refused.text();
    assertEquals(refused.status, 422, text);
    assert(text.includes("ticket_source_workflow_starts_overlap"), text);
    await fx.owner.query(
      `update bakery.ticket_sources set policy = $2::jsonb where id = $1`,
      [
        sourceId,
        JSON.stringify({
          ...automaticPolicy(fx),
          workflow: { workflowId: written.workflowId },
        }),
      ],
    );
    a.seedLabeler();
    a.issue(621);
    const routes = await a.deliverRoutes(621);
    await processAutomationRoute(fx.runtime, routes.automation);
    const failing = new Proxy(a.live, {
      get(target, key, receiver) {
        if (key === "readIssue") {
          return () =>
            Promise.resolve({ kind: "unavailable", reason: "rate_limited" });
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await runsOfOrganization(fx);
    await a.intake(routes.fact_refresh, { reader: failing });
    assertEquals(await runsOfOrganization(fx), before);
    await seedFact(a, 621, "2026-11-01T00:00:00.000Z", [EXECUTE_LABEL]);
    a.index.set(621, new Date().toISOString(), [EXECUTE_LABEL]);
    await a.poll();
    assertEquals(await runsOfOrganization(fx), before + 1, "one run for 621");
    const ofWritten = await fx.owner.query<{ count: string }>(
      `select count(*)::text as count from bakery.workflow_runs
        where organization_id = $1 and workflow_version_id = $2`,
      [fx.organizationId, written.versionId],
    );
    assertEquals(ofWritten.rows[0]?.count, "1");
    assertEquals((await fx.counts(sourceId)).requests, 1);
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
