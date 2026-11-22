import { assertEquals } from "@std/assert";
import {
  TICKET_REASON_CODES,
  TICKET_REQUEST_DISPOSITIONS,
} from "../../packages/contracts/src/ticket-admission.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  dispositionReasonCode,
  pausedReason,
  TICKET_DISPOSITION_REASON_CODES,
  ticketRequestProgress,
} from "../../apps/server/src/modules/work/ticket-request-state.ts";

/*
 * Issue 69: the pure projections behind ticketRequests.list and .get.
 */

const RUN_STATUSES = [
  null,
  "queued",
  "running",
  "waiting_input",
  "waiting_capacity",
  "paused",
  "canceling",
  "canceled",
  "completed",
  "failed",
  "blocked",
] as const;

/** The expected progress, written out row by row for every disposition. */
const EXPECTED: Record<string, Record<string, string>> = {
  pending: Object.fromEntries(RUN_STATUSES.map((s) => [String(s), "pending"])),
  // A suspended request shows its run's end once the run finished (#61).
  suspended: {
    ...Object.fromEntries(RUN_STATUSES.map((s) => [String(s), "suspended"])),
    canceled: "canceled",
    completed: "completed",
    failed: "failed",
  },
  rejected: Object.fromEntries(
    RUN_STATUSES.map((s) => [String(s), "rejected"]),
  ),
  completed: Object.fromEntries(
    RUN_STATUSES.map((s) => [String(s), "completed"]),
  ),
  failed: Object.fromEntries(RUN_STATUSES.map((s) => [String(s), "failed"])),
  canceled: Object.fromEntries(
    RUN_STATUSES.map((s) => [String(s), "canceled"]),
  ),
};
for (const disposition of ["waiting", "admitted", "active"]) {
  EXPECTED[disposition] = {
    null: disposition,
    queued: "admitted",
    running: "active",
    waiting_input: "waiting",
    waiting_capacity: "waiting",
    paused: "suspended",
    canceling: "active",
    canceled: "canceled",
    completed: "completed",
    failed: "failed",
    blocked: "waiting",
  };
}

Deno.test("issue 69: progress is defined for every disposition and run status", () => {
  for (const disposition of TICKET_REQUEST_DISPOSITIONS) {
    for (const status of RUN_STATUSES) {
      assertEquals(
        ticketRequestProgress(disposition, status, true),
        EXPECTED[disposition][String(status)],
        `${disposition} with run ${status}`,
      );
    }
  }
  // A status this build does not know leaves the disposition as stored.
  assertEquals(
    ticketRequestProgress("active", "something_new", true),
    "active",
  );
});

Deno.test("issue 32: a completed run reads as active until the completion policy is met", () => {
  assertEquals(ticketRequestProgress("active", "completed", false), "active");
  assertEquals(ticketRequestProgress("active", "completed", true), "completed");
  // A run that failed or was stopped never waits on delivery.
  assertEquals(ticketRequestProgress("active", "failed", false), "failed");
  assertEquals(ticketRequestProgress("active", "canceled", false), "canceled");
  // A stored disposition is shown as stored.
  assertEquals(
    ticketRequestProgress("completed", "completed", false),
    "completed",
  );
});

Deno.test("issue 61: a suspended request reports the end of its run", () => {
  // Stop work cancels a paused run: the page must read canceled, not wait
  // for the recheck to move the disposition.
  assertEquals(
    ticketRequestProgress("suspended", "canceled", false),
    "canceled",
  );
  assertEquals(ticketRequestProgress("suspended", "failed", false), "failed");
  assertEquals(
    ticketRequestProgress("suspended", "completed", true),
    "completed",
  );
  // An undelivered completed run, and a paused or running one, stay suspended.
  assertEquals(
    ticketRequestProgress("suspended", "completed", false),
    "suspended",
  );
  assertEquals(ticketRequestProgress("suspended", "paused", true), "suspended");
  assertEquals(ticketRequestProgress("suspended", null, true), "suspended");
});

Deno.test("issue 69: a stored disposition reason maps to its closed code, anything else to null", () => {
  for (const code of TICKET_DISPOSITION_REASON_CODES) {
    assertEquals(dispositionReasonCode(code), code);
  }
  // Reasons that never reach a disposition are not codes of one.
  for (
    const code of TICKET_REASON_CODES.filter((code) =>
      !(TICKET_DISPOSITION_REASON_CODES as readonly string[]).includes(code)
    )
  ) {
    assertEquals(dispositionReasonCode(code), null, code);
  }
  assertEquals(dispositionReasonCode(null), null);
  assertEquals(dispositionReasonCode("free text"), null);
  // The contract's enum is exactly this set.
  const view = (code: string | null) => ({
    id: crypto.randomUUID(),
    externalTicketId: crypto.randomUUID(),
    ticketTaskLinkId: crypto.randomUUID(),
    intent: "start",
    origin: "manual",
    requestedByPrincipalId: null,
    triggerLabelName: null,
    disposition: "suspended",
    dispositionReasonCode: code,
    pausedAt: null,
    pausedReason: null,
    progress: "suspended",
    workflowRunId: null,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    version: 1,
    targets: [],
  });
  const schema = contractSchemas.TicketRequestView;
  for (const code of [...TICKET_DISPOSITION_REASON_CODES, null]) {
    assertEquals(schema.safeParse(view(code)).success, true, String(code));
  }
  assertEquals(schema.safeParse(view("ok")).success, false);
});

Deno.test("issue 69: a paused request names its cause from the suspension reason", () => {
  const at = new Date();
  const cases: [string, string | null][] = [
    ["acceptance_changed", "edited_after_setup"],
    ["label_withdrawn", "label_removed"],
    ["label_missing", "label_removed"],
    ["held", "hold_label_added"],
    ["proof_unavailable", "dependency_unreadable"],
    ["inaccessible", "dependency_unreadable"],
    ["links_truncated", "dependency_unreadable"],
    ["ticket_closed", null],
    ["provider_unavailable", null],
  ];
  for (const [reason, expected] of cases) {
    assertEquals(pausedReason(at, reason), expected, reason);
    assertEquals(pausedReason(null, reason), null, `${reason} unpaused`);
  }
  assertEquals(pausedReason(at, null), null);
});
