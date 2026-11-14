import { assertEquals } from "@std/assert";
import {
  issueMatchesFilter,
  issueNumber,
  type IssueRow,
  issueSnapshot,
  issueStatus,
  reasonKey,
  referencedNumber,
} from "../../apps/web/src/pages/issue-state.ts";

const check = (
  id: string,
  status: "pass" | "wait" | "reject",
  reason: string,
  evidence: string[] = [],
) => ({ id, status, reason, evidence: evidence.map((ref) => ({ ref })) });

const ticket = (overrides: Record<string, unknown> = {}): IssueRow =>
  ({
    id: "t-1",
    ticketSourceId: "s-1",
    number: "12",
    safeUrl: "https://github.com/acme/web/issues/12",
    state: "open",
    snapshot: {
      title: "Export invoices as CSV",
      labels: ["ready for agent"],
      state: "open",
      repositoryFullName: "acme/web",
    },
    latestReadiness: null,
    activeRequest: null,
    ...overrides,
  }) as unknown as IssueRow;

const readiness = (verdict: string, checks: unknown[]) => ({
  verdict,
  checks,
});

Deno.test("an issue never checked is unknown, never ready to start", () => {
  assertEquals(issueStatus(ticket()), {
    status: "unknown",
    reason: "not_checked",
  });
  assertEquals(issueMatchesFilter(ticket(), "canStart"), false);
  assertEquals(issueMatchesFilter(ticket(), "open"), true);
});

Deno.test("the readiness verdict decides ready, waiting and cannot start, with the reason of the deciding check", () => {
  assertEquals(
    issueStatus(
      ticket({
        latestReadiness: readiness("ready", [
          check("source_live", "pass", "ok"),
        ]),
      }),
    ),
    { status: "canStart", reason: null },
  );
  assertEquals(
    issueStatus(
      ticket({
        latestReadiness: readiness("waiting", [
          check("source_live", "pass", "ok"),
          check("dependencies_satisfied", "wait", "predecessor_open", [
            "blocker:acme/web#201",
          ]),
        ]),
      }),
    ),
    { status: "waiting", reason: "predecessor_open" },
  );
  // A rejection outranks an earlier wait.
  assertEquals(
    issueStatus(
      ticket({
        latestReadiness: readiness("rejected", [
          check("dependencies_satisfied", "wait", "predecessor_open"),
          check("acceptance_present", "reject", "acceptance_missing"),
        ]),
      }),
    ),
    { status: "cannotStart", reason: "acceptance_missing" },
  );
});

Deno.test("a request already running outranks the verdict, and closed issues are closed", () => {
  const verdict = readiness("ready", [check("source_live", "pass", "ok")]);
  for (const disposition of ["admitted", "active"]) {
    assertEquals(
      issueStatus(
        ticket({
          latestReadiness: verdict,
          activeRequest: { disposition, dispositionReason: null },
        }),
      ),
      { status: "inProgress", reason: null },
    );
  }
  assertEquals(
    issueStatus(
      ticket({
        latestReadiness: verdict,
        activeRequest: { disposition: "waiting", dispositionReason: "held" },
      }),
    ),
    { status: "waitingToStart", reason: "held" },
  );
  assertEquals(
    issueStatus(
      ticket({
        activeRequest: {
          disposition: "suspended",
          dispositionReason: "label_withdrawn",
        },
      }),
    ),
    { status: "paused", reason: "label_withdrawn" },
  );
  const closed = ticket({
    state: "closed",
    snapshot: {
      title: "Old",
      labels: [],
      state: "closed",
      repositoryFullName: "acme/web",
    },
  });
  assertEquals(issueStatus(closed), {
    status: "closed",
    reason: "ticket_closed",
  });
  assertEquals(issueMatchesFilter(closed, "closed"), true);
  assertEquals(issueMatchesFilter(closed, "open"), false);
});

Deno.test("the filters sort issues into can start, open, in progress and closed", () => {
  const ready = ticket({
    latestReadiness: readiness("ready", [check("source_live", "pass", "ok")]),
  });
  const running = ticket({
    activeRequest: { disposition: "active", dispositionReason: null },
  });
  const waiting = ticket({
    latestReadiness: readiness("waiting", [
      check("dependencies_satisfied", "wait", "predecessor_open"),
    ]),
  });
  assertEquals(
    [ready, running, waiting].map((row) => issueMatchesFilter(row, "canStart")),
    [true, false, false],
  );
  assertEquals(
    [ready, running, waiting].map((row) =>
      issueMatchesFilter(row, "inProgress")
    ),
    [false, true, false],
  );
  assertEquals(
    [ready, running, waiting].map((row) => issueMatchesFilter(row, "open")),
    [true, true, true],
  );
});

Deno.test("a saved copy with missing or odd fields reads as empty, never throws", () => {
  const odd = ticket({ snapshot: 7, number: null, latestReadiness: "x" });
  assertEquals(issueSnapshot(odd).title, "");
  assertEquals(issueSnapshot(odd).labels, []);
  assertEquals(issueNumber(odd), null);
  assertEquals(issueNumber(ticket()), 12);
  assertEquals(issueStatus(odd).status, "unknown");
});

Deno.test("reason codes map to their sentence, the provider ones fold into one and unknown codes stay unknown", () => {
  assertEquals(reasonKey("predecessor_open"), "predecessor_open");
  assertEquals(reasonKey("provider:rate_limited"), "provider_unavailable");
  assertEquals(reasonKey("provider:timeout"), "provider_unavailable");
  assertEquals(reasonKey("something_new"), "unknown");
  assertEquals(referencedNumber("acme/web#201"), "201");
  assertEquals(referencedNumber(null), null);
});
