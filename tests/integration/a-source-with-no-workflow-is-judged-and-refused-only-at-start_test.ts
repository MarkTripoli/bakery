import { assert, assertEquals } from "@std/assert";
import { defaultTicketSourcePolicy } from "../../packages/contracts/src/ticket-admission.ts";
import {
  EXECUTE_LABEL,
  recordOpenIssues,
  withTicketFixture,
} from "../helpers/ticket-admission/fixtures.ts";
import {
  read,
  ticketCall,
  type TicketView,
} from "../helpers/ticket-admission/operations-http.ts";

type StoredReport = { preset: unknown; checks: { id: string }[] };
type Preview = {
  issues: { number: number; outcome: string; reasons: string[] }[];
};

async function ticketByNumber(
  fx: Parameters<typeof ticketCall>[0],
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

Deno.test("issue 407: a source with no workflow records readiness, previews, syncs a labelled issue, and refuses only Start work", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: defaultTicketSourcePolicy(),
    });
    assertEquals(defaultTicketSourcePolicy().preset, undefined);
    fx.reader.setIssue({ number: 1, labels: [] });
    fx.reader.setIssue({ number: 2, labels: [EXECUTE_LABEL] });
    for (const number of [1, 2]) {
      fx.facts.set(number, `2026-06-01T00:00:0${number}Z`);
    }

    await recordOpenIssues(fx, sourceId);
    const counted = await fx.counts(sourceId);
    assertEquals([counted.reports, counted.requests], [2, 0]);

    const first = await ticketByNumber(fx, 1);
    const recorded = await ticketCall(
      fx,
      "POST",
      `/v1/external-tickets/${first.id}/readiness-checks`,
      { body: { expectedSourcePolicyRevision: 1 } },
    );
    assertEquals(recorded.status, 201, await recorded.clone().text());
    const stored = await fx.owner.query<StoredReport>(
      `select preset, checks from bakery.ticket_readiness_reports
        where organization_id = $1 and external_ticket_id = $2
        order by version desc limit 1`,
      [fx.organizationId, first.id],
    );
    assertEquals(stored.rows[0]?.preset, null);
    assert(
      stored.rows[0].checks.every((check) => check.id !== "preset_ready"),
      JSON.stringify(stored.rows[0].checks),
    );

    const preview = await read<Preview>(
      await ticketCall(fx, "POST", `/v1/ticket-sources/${sourceId}/previews`, {
        body: {},
      }),
      201,
    );
    assertEquals(
      preview.issues.map((issue) => issue.number).sort(),
      [1, 2],
      JSON.stringify(preview.issues),
    );

    const refused = await ticketCall(
      fx,
      "POST",
      `/v1/external-tickets/${first.id}/requests`,
      {
        body: {
          intent: "start",
          expectedSourcePolicyRevision: 1,
          requirementsDigest: first.requirementsDigest,
        },
      },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
    assert((await refused.text()).includes("ticket_workflow_required"));
    assertEquals((await fx.counts(sourceId)).requests, 0);
  }, { budget: true }));
