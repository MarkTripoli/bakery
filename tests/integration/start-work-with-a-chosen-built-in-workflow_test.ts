import { assert, assertEquals } from "@std/assert";
import {
  EXECUTE_LABEL,
  recordOpenIssues,
  type TicketFixture,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
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

type Created = {
  id: string;
  disposition: string;
  workflowRunId: string | null;
  pinnedPreset: { id: string; revision: number };
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
    assertEquals(standard.pinnedPreset.id, "fixed-coding");
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
      ["fixed-coding", standard.pinnedPreset.revision],
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
      policy: { ...fx.policy(), preset: "fixed-coding-reviewed" },
    });
    fx.reader.setIssue({ number: 615, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 615, intent: "start" });
    assertEquals(admitted.request, null);
    const check = admitted.report.checks.find((entry) =>
      entry.id === "preset_ready"
    )!;
    assertEquals(
      [check.status, check.reason, check.evidence[0].ref],
      ["wait", "preset_setup_required", "preset:fixed-coding-reviewed"],
    );
    assertEquals(admitted.report.preset?.id, "fixed-coding-reviewed");
  }, { budget: true }));

Deno.test("issue 61: a ready reviewed workflow is admitted and its run is that workflow", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: { ...fx.policy(), preset: "fixed-coding-reviewed" },
    });
    fx.reader.setIssue({ number: 616, labels: [EXECUTE_LABEL] });
    const admitted = await fx.admit(sourceId, { number: 616, intent: "start" });
    const request = admitted.request;
    assert(request, JSON.stringify(admitted.report.checks));
    assertEquals(admitted.report.preset?.id, "fixed-coding-reviewed");
    const run = await fx.owner.query<{ workflow_run_id: string | null }>(
      `select workflow_run_id from bakery.ticket_requests where id = $1`,
      [request.id],
    );
    const runId = run.rows[0]?.workflow_run_id;
    assert(runId, "the admitted request started a run");
    assertEquals(await runPreset(fx, runId), "preset:fixed-coding-reviewed");
  }, { budget: true, reviewed: true }));
