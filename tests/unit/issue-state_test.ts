import { assertEquals } from "@std/assert";
import {
  issueLinks,
  issueMatchesFilter,
  issueNumber,
  type IssueRow,
  issueSnapshot,
  issueStatus,
  reasonAction,
  reasonKey,
  referencedNumber,
  startOffer,
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

Deno.test("Start work is offered only when ready, Start when ready only when dependencies are all that is in the way", () => {
  const ready = ticket({
    latestReadiness: readiness("ready", [check("source_live", "pass", "ok")]),
  });
  assertEquals(startOffer(ready), "start");
  const dependencyWait = ticket({
    latestReadiness: readiness("waiting", [
      check("source_live", "pass", "ok"),
      check("dependencies_satisfied", "wait", "predecessor_open", [
        "blocker:acme/web#201",
      ]),
    ]),
  });
  assertEquals(startOffer(dependencyWait), "startWhenReady");
  // A dependency wait with another thing in the way is not enough.
  const twoThings = ticket({
    latestReadiness: readiness("waiting", [
      check("dependencies_satisfied", "wait", "predecessor_open"),
      check("repository_ready", "wait", "provider_unavailable"),
    ]),
  });
  assertEquals(startOffer(twoThings), "none");
  assertEquals(
    startOffer(ticket({
      latestReadiness: readiness("rejected", [
        check("acceptance_present", "reject", "acceptance_missing"),
      ]),
    })),
    "none",
  );
  // Running work, and an issue never checked, offer nothing.
  assertEquals(
    startOffer(ticket({
      latestReadiness: readiness("ready", [check("source_live", "pass", "ok")]),
      activeRequest: { disposition: "active" },
    })),
    "none",
  );
  assertEquals(startOffer(ticket()), "none");
});

Deno.test("each reason leads to where the fix lives", () => {
  assertEquals(reasonAction("acceptance_missing"), {
    kind: "github",
    label: "addCriteria",
  });
  assertEquals(reasonAction("held"), { kind: "github", label: "removeLabel" });
  assertEquals(reasonAction("provider:timeout"), { kind: "checkAgain" });
  assertEquals(reasonAction("inaccessible"), { kind: "integrations" });
  assertEquals(reasonAction("source_disabled"), { kind: "issueSettings" });
  assertEquals(reasonAction("no_active_profile"), { kind: "projects" });
  assertEquals(reasonAction("actor_role_insufficient"), { kind: "askAdmin" });
  assertEquals(reasonAction("acceptance_changed"), { kind: "startAgain" });
  assertEquals(reasonAction("repository_archived"), { kind: "none" });
  assertEquals(reasonAction("brand_new_code"), { kind: "none" });
});

Deno.test("dependencies take their state from the check's evidence, and unread links are said to be incomplete", () => {
  const withLinks = (links: unknown, row: Record<string, unknown> = {}) =>
    ticket({
      snapshot: {
        title: "T",
        labels: [],
        state: "open",
        repositoryFullName: "acme/web",
        body: "Body",
        bodyTruncated: true,
        links,
      },
      ...row,
    });
  const refs = [
    { id: "a", repositoryFullName: "acme/web", number: 201 },
    { id: "b", repositoryFullName: "acme/api", number: 7 },
  ];
  const links = {
    parent: { id: "p", repositoryFullName: "acme/web", number: 100 },
    subIssuesTotal: 0,
    blockedBy: refs,
    blockingTotal: 0,
  };
  const waiting = issueLinks(withLinks(links, {
    latestReadiness: readiness("waiting", [
      check("dependencies_satisfied", "wait", "predecessor_open", [
        "blocker:acme/web#201",
      ]),
    ]),
  }));
  assertEquals(waiting.dependencies, [
    { repository: "acme/web", number: 201, state: "open" },
    { repository: "acme/api", number: 7, state: "done" },
  ]);
  assertEquals(waiting.parent, { repository: "acme/web", number: 100 });
  assertEquals(waiting.incomplete, false);
  assertEquals(
    issueLinks(withLinks(links)).dependencies.map((dependency) =>
      dependency.state
    ),
    [
      "unknown",
      "unknown",
    ],
  );
  assertEquals(issueLinks(withLinks(null)).incomplete, true);
  assertEquals(
    issueLinks(withLinks(links, {
      latestReadiness: readiness("waiting", [
        check("dependencies_satisfied", "wait", "links_truncated"),
      ]),
    })).incomplete,
    true,
  );
});
