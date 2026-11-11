import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  defaultTicketSourcePolicy,
  TICKET_CHECK_IDS,
  TICKET_CHECK_MAX_EVIDENCE,
  TICKET_CHECK_REASONS,
  TICKET_PROVIDER_BODY_MAX_CODE_POINTS,
  TicketReadinessReportSchema,
} from "../../../packages/contracts/src/ticket-admission.ts";
import type {
  TicketCheckId,
  TicketIssueRef,
  TicketReadinessReport,
  TicketSnapshotInput,
  TicketSourcePolicy,
} from "../../../packages/contracts/src/ticket-admission.ts";
import {
  evaluateReadiness,
  hasAcceptanceCriteria,
  type ReadinessInput,
} from "../../../apps/server/src/modules/work/ticket-readiness.ts";
import {
  decideRecheck,
  type RecheckCurrent,
} from "../../../apps/server/src/modules/work/ticket-request-state.ts";
import {
  type BlockerProofEntry,
  normalizeSnapshot,
  requirementsDigest,
} from "../../../apps/server/src/modules/work/ticket-snapshot.ts";
import type {
  PredecessorProof,
  TicketActorRole,
  TicketIssueRead,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketReadFailure,
} from "../../../apps/server/src/modules/work/ticket-source-reader.ts";

/**
 * Issue 82 unit lane: the readiness evaluator. Every check has a pass, a wait
 * and (where it can) a reject path; a provider failure never passes; the
 * verdict is `ready` only when every check passes; a seeded property run over
 * random inputs holds the same invariants.
 */

const MARKER = "2026-11-01T00:00:00Z";
const SINCE = "2026-11-01T00:00:00.000Z";
const BEFORE = "2026-10-31T23:59:59.999Z";
const AFTER = "2026-11-01T00:00:01.000Z";
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "1001";
const CRITERIA_BODY = "Summary\n\n### Acceptance criteria\n- exports a file\n";

const PRESET = {
  id: "fixed-coding" as const,
  revision: 1,
  digest: "c".repeat(64),
};

const FAILURE: TicketReadFailure = {
  kind: "unavailable",
  reason: "rate_limited",
  retryAfterSeconds: 30,
};

function ref(number: number, repository = "owner/repo"): TicketIssueRef {
  return { id: String(9000 + number), number, repositoryFullName: repository };
}

function issueSnapshot(
  overrides: Partial<TicketSnapshotInput> = {},
): TicketSnapshotInput {
  return {
    externalId: "4242",
    number: 12,
    title: "Add the export button",
    body: CRITERIA_BODY,
    bodyTooLarge: false,
    labels: ["ready for agent"],
    state: "open",
    stateReason: null,
    locked: false,
    repositoryFullName: "owner/repo",
    ...overrides,
  };
}

function presentIssue(
  overrides: Partial<TicketSnapshotInput> = {},
  providerUpdatedAt = MARKER,
): TicketIssueRead {
  return {
    kind: "present",
    snapshot: issueSnapshot(overrides),
    providerUpdatedAt,
    visibility: "private",
  };
}

function presentLinks(
  overrides: Partial<Extract<TicketLinksRead, { kind: "present" }>> = {},
): TicketLinksRead {
  return {
    kind: "present",
    parent: null,
    subIssuesTotal: 0,
    blockedBy: [],
    blockingTotal: 0,
    truncated: false,
    ...overrides,
  };
}

function satisfiedProof(number: number): BlockerProofEntry {
  return {
    blocker: ref(number),
    proof: {
      kind: "satisfied",
      pullRequestNumber: 100 + number,
      mergeSha: String(number).padStart(40, "a"),
      mergedAt: MARKER,
    },
  };
}

function entry(number: number, proof: PredecessorProof | TicketReadFailure) {
  return { blocker: ref(number), proof } satisfies BlockerProofEntry;
}

function delegatedPolicy(
  overrides: { enabled?: boolean; since?: string | null } = {},
): TicketSourcePolicy {
  const enabled = overrides.enabled ?? true;
  return {
    ...defaultTicketSourcePolicy(),
    delegation: {
      principalId: PRINCIPAL_ID,
      githubActorIds: [ACTOR_ID, "1002"],
    },
    automatic: {
      enabled,
      since: overrides.since === undefined
        ? (enabled ? SINCE : null)
        : overrides.since,
    },
  };
}

function applied(
  appliedAt = AFTER,
  actorId = ACTOR_ID,
): TicketLabelProvenance {
  return { kind: "applied", actorId, actorLogin: "octocat", appliedAt };
}

function role(
  permission: "admin" | "write" | "read" | "none" = "write",
  userId = ACTOR_ID,
): TicketActorRole {
  return { kind: "present", userId, permission };
}

/** A manual request on a clean issue: every check passes. */
function readyInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    source: {
      enabled: true,
      connectionEnabled: true,
      installationEnabled: true,
      resourceSelected: true,
      repositoryFullName: "owner/repo",
      repositoryArchived: false,
      repositoryHasActiveProfile: true,
      presetReady: true,
    },
    policy: defaultTicketSourcePolicy(),
    policyRevision: 3,
    preset: PRESET,
    issue: presentIssue(),
    links: presentLinks(),
    proofs: [],
    authority: { principalActive: true, provenance: null, actorRole: null },
    activeRequest: null,
    intent: "start",
    origin: "manual",
    labelBasis: "manual",
    pinnedRequirementsDigest: null,
    ...overrides,
  };
}

/** An automatic admission by an allowlisted, writing actor after `since`. */
function automaticInput(
  overrides: Partial<ReadinessInput> = {},
): ReadinessInput {
  return readyInput({
    policy: delegatedPolicy(),
    origin: "webhook",
    labelBasis: "label",
    authority: {
      principalActive: true,
      provenance: applied(),
      actorRole: role("write"),
    },
    ...overrides,
  });
}

function outcome(report: TicketReadinessReport, id: TicketCheckId) {
  const found = report.checks.find((check) => check.id === id);
  return found === undefined ? undefined : [found.status, found.reason];
}

async function evaluate(input: ReadinessInput): Promise<TicketReadinessReport> {
  const report = await evaluateReadiness(input);
  const parsed = TicketReadinessReportSchema.safeParse(report);
  assert(
    parsed.success,
    `the report fits the contract schema: ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    }`,
  );
  return report;
}

Deno.test("issue 82 unit readiness: a clean manual request is ready with every check passing", async () => {
  const report = await evaluate(readyInput());
  assertEquals(report.verdict, "ready");
  assertEquals(
    report.checks.map((check) => check.id),
    TICKET_CHECK_IDS.filter((id) => id !== "requirements_unchanged"),
    "all checks, in contract order; the pin check appears only with a pin",
  );
  assert(report.checks.every((check) => check.status === "pass"));
  assert(report.checks.every((check) => check.reason === "ok"));
  assertEquals(report.version, 1);
  assertEquals(report.sourcePolicyRevision, 3);
  assertEquals(report.preset, PRESET);
  assertEquals(typeof report.requirementsDigest, "string");
  assertEquals(typeof report.dependencyDigest, "string");
  assert(
    report.checks.every((check) =>
      check.evidence.length <= TICKET_CHECK_MAX_EVIDENCE
    ),
  );
});

Deno.test("issue 82 unit readiness: a matching pin adds a passing requirements_unchanged check", async () => {
  const live = await requirementsDigest(
    normalizeSnapshot(issueSnapshot(), {
      links: null,
      providerUpdatedAt: MARKER,
    }),
  );
  const report = await evaluate(readyInput({ pinnedRequirementsDigest: live }));
  assertEquals(report.verdict, "ready");
  assertEquals(report.checks.length, TICKET_CHECK_IDS.length);
  assertEquals(outcome(report, "requirements_unchanged"), ["pass", "ok"]);
  assertEquals(report.requirementsDigest, live);
});

Deno.test("issue 82 unit readiness: source_live reports the first broken link of the chain", async () => {
  const base = readyInput().source;
  const cases: [string, Partial<typeof base>, string][] = [
    ["disabled source", { enabled: false }, "source_disabled"],
    ["connection", { connectionEnabled: false }, "connection_not_enabled"],
    [
      "installation",
      { installationEnabled: false },
      "installation_not_enabled",
    ],
    ["resource", { resourceSelected: false }, "resource_not_selected"],
    [
      "several at once",
      {
        connectionEnabled: false,
        installationEnabled: false,
        resourceSelected: false,
      },
      "connection_not_enabled",
    ],
  ];
  for (const [name, change, reason] of cases) {
    const report = await evaluate(
      readyInput({ source: { ...base, ...change } }),
    );
    assertEquals(outcome(report, "source_live"), ["wait", reason], name);
    assertEquals(report.verdict, "waiting", name);
  }
});

Deno.test("issue 82 unit readiness: ticket_supported accepts an open issue of the source repository and refuses the rest", async () => {
  const cases: [string, TicketIssueRead, string, string][] = [
    [
      "closed",
      presentIssue({ state: "closed", stateReason: "completed" }),
      "reject",
      "ticket_closed",
    ],
    [
      "pull request",
      { kind: "pull_request" },
      "reject",
      "pull_request_not_ticket",
    ],
    ["gone", { kind: "gone" }, "reject", "ticket_gone"],
    ["moved", { kind: "moved" }, "reject", "ticket_moved"],
    [
      "other repository",
      presentIssue({ repositoryFullName: "owner/elsewhere" }),
      "reject",
      "repository_mismatch",
    ],
    [
      "body flagged too large",
      presentIssue({ body: "", bodyTooLarge: true }),
      "reject",
      "requirements_too_large",
    ],
    ["provider unavailable", FAILURE, "wait", "provider_unavailable"],
    [
      "repository case differs",
      presentIssue({ repositoryFullName: "Owner/Repo" }),
      "pass",
      "ok",
    ],
  ];
  for (const [name, issue, status, reason] of cases) {
    const report = await evaluate(readyInput({ issue }));
    assertEquals(outcome(report, "ticket_supported"), [status, reason], name);
  }
});

Deno.test("issue 82 unit readiness: a body past 65,536 code points is rejected, one at the limit is not", async () => {
  const limit = TICKET_PROVIDER_BODY_MAX_CODE_POINTS;
  for (const character of ["x", "é", "日", "\u{1F600}"]) {
    const prefix = CRITERIA_BODY;
    const room = limit - [...prefix].length;
    const atLimit = `${prefix}${character.repeat(room)}`;
    assertEquals([...atLimit].length, limit);
    const fits = await evaluateReadiness(
      readyInput({ issue: presentIssue({ body: atLimit }) }),
    );
    assertEquals(outcome(fits, "ticket_supported"), ["pass", "ok"], character);
    assertEquals(fits.verdict, "ready");
    // The reader keeps no text of an oversized body; an unflagged oversized
    // body (a reader bug) is still caught by the code point count.
    const over = await evaluateReadiness(
      readyInput({
        issue: {
          kind: "present",
          snapshot: { ...issueSnapshot({ body: `${atLimit}${character}` }) },
          providerUpdatedAt: MARKER,
          visibility: "private",
        },
      }),
    );
    assertEquals(
      outcome(over, "ticket_supported"),
      ["reject", "requirements_too_large"],
      character,
    );
    assertEquals(
      over.requirementsDigest,
      null,
      "a too-large body is not hashed",
    );
  }
});

Deno.test("issue 82 unit readiness: checks that need an issue are left out when it is gone, moved or a pull request", async () => {
  for (
    const issue of [{ kind: "gone" }, { kind: "moved" }, {
      kind: "pull_request",
    }] as const
  ) {
    const report = await evaluate(
      readyInput({ issue, pinnedRequirementsDigest: "a".repeat(64) }),
    );
    assertEquals(report.verdict, "rejected");
    assertEquals(
      report.checks.map((check) => check.id),
      [
        "source_live",
        "ticket_supported",
        "no_active_admission",
        "repository_ready",
        "preset_ready",
        "authority_live",
      ],
    );
    assertEquals(report.requirementsDigest, null);
  }
});

Deno.test("issue 82 unit readiness: not_held waits on the hold label whatever else is set", async () => {
  const held = await evaluate(readyInput({
    issue: presentIssue({ labels: ["ready for agent", "bakery:hold"] }),
  }));
  assertEquals(outcome(held, "not_held"), ["wait", "held"]);
  assertEquals(held.verdict, "waiting");
  const clear = await evaluate(readyInput({
    issue: presentIssue({ labels: ["Bakery:Hold", "hold"] }),
  }));
  assertEquals(outcome(clear, "not_held"), ["pass", "ok"], "exact names only");
});

Deno.test("issue 82 unit readiness: intent_authorized by label basis", async () => {
  const manual = await evaluate(
    readyInput({ issue: presentIssue({ labels: [] }) }),
  );
  assertEquals(
    outcome(manual, "intent_authorized"),
    ["pass", "ok"],
    "manual needs no label",
  );

  const labeled = readyInput({ labelBasis: "label", origin: "adoption" });
  const cases: [string, ReadinessInput, string, string][] = [
    ["label present", labeled, "pass", "ok"],
    [
      "label missing",
      { ...labeled, issue: presentIssue({ labels: ["bug"] }) },
      "wait",
      "label_missing",
    ],
    [
      "label withdrawn from an existing request",
      {
        ...labeled,
        issue: presentIssue({ labels: [] }),
        activeRequest: { intent: "start" },
      },
      "wait",
      "label_withdrawn",
    ],
    [
      "planning label does not cover start",
      { ...labeled, issue: presentIssue({ labels: ["ready for planning"] }) },
      "wait",
      "label_missing",
    ],
    [
      "planning label covers plan",
      {
        ...labeled,
        intent: "plan",
        issue: presentIssue({ labels: ["ready for planning"] }),
      },
      "pass",
      "ok",
    ],
    [
      "execute label covers plan",
      { ...labeled, intent: "plan" },
      "pass",
      "ok",
    ],
    ["nothing asked", { ...labeled, intent: null }, "wait", "label_missing"],
    [
      "hold does not hide the label",
      {
        ...labeled,
        issue: presentIssue({ labels: ["ready for agent", "bakery:hold"] }),
      },
      "pass",
      "ok",
    ],
  ];
  for (const [name, input, status, reason] of cases) {
    const report = await evaluate(input);
    assertEquals(outcome(report, "intent_authorized"), [status, reason], name);
  }
});

Deno.test("issue 82 unit readiness: automatic origins need the window, a provenance and a label at or after since", async () => {
  const cases: [string, Partial<ReadinessInput>, string, string][] = [
    ["inside the window", {}, "pass", "ok"],
    ["poll origin", { origin: "poll" }, "pass", "ok"],
    [
      "applied exactly at since",
      {
        authority: {
          principalActive: true,
          provenance: applied(SINCE),
          actorRole: role(),
        },
      },
      "pass",
      "ok",
    ],
    [
      "applied before since",
      {
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "automatic admission off",
      { policy: delegatedPolicy({ enabled: false }) },
      "wait",
      "adoption_required",
    ],
    [
      "provenance absent",
      {
        authority: {
          principalActive: true,
          provenance: { kind: "absent" },
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "provenance unverifiable",
      {
        authority: {
          principalActive: true,
          provenance: {
            kind: "unverifiable",
            reason: "events past the page bound",
          },
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "provenance not read",
      {
        authority: { principalActive: true, provenance: null, actorRole: null },
      },
      "wait",
      "adoption_required",
    ],
    [
      "provenance read failed",
      {
        authority: {
          principalActive: true,
          provenance: FAILURE,
          actorRole: null,
        },
      },
      "wait",
      "provider_unavailable",
    ],
    [
      "an existing request is past the window",
      {
        activeRequest: { intent: "start" },
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
      "pass",
      "ok",
    ],
    [
      "explicit adoption ignores the window",
      {
        origin: "adoption",
        policy: delegatedPolicy({ enabled: false }),
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: null,
        },
      },
      "pass",
      "ok",
    ],
    [
      "a plan request asked to start needs the window: label before since",
      {
        activeRequest: { intent: "plan" },
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "a plan request asked to start needs the window: poll origin",
      {
        origin: "poll",
        activeRequest: { intent: "plan" },
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "a plan request asked to start needs the window: automatic admission off",
      {
        activeRequest: { intent: "plan" },
        policy: delegatedPolicy({ enabled: false }),
      },
      "wait",
      "adoption_required",
    ],
    [
      "a plan request asked to start needs the window: switch off beside a since",
      {
        activeRequest: { intent: "plan" },
        policy: delegatedPolicy({ enabled: false, since: SINCE }),
      },
      "wait",
      "adoption_required",
    ],
    [
      "a plan request asked to start needs the window: no since",
      {
        activeRequest: { intent: "plan" },
        policy: {
          ...delegatedPolicy(),
          automatic: { enabled: true, since: null },
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "a plan request asked to start needs the window: provenance not read",
      {
        activeRequest: { intent: "plan" },
        authority: { principalActive: true, provenance: null, actorRole: null },
      },
      "wait",
      "adoption_required",
    ],
    [
      "a plan request asked to start needs the window: provenance read failed",
      {
        activeRequest: { intent: "plan" },
        authority: {
          principalActive: true,
          provenance: FAILURE,
          actorRole: null,
        },
      },
      "wait",
      "provider_unavailable",
    ],
    [
      "a plan request asked to start passes with a label applied after since",
      { activeRequest: { intent: "plan" } },
      "pass",
      "ok",
    ],
    [
      "a plan request asked to start passes with a label applied exactly at since",
      {
        activeRequest: { intent: "plan" },
        authority: {
          principalActive: true,
          provenance: applied(SINCE),
          actorRole: role(),
        },
      },
      "pass",
      "ok",
    ],
    [
      "a plan request asked to start by an explicit adoption ignores the window",
      {
        origin: "adoption",
        activeRequest: { intent: "plan" },
        policy: delegatedPolicy({ enabled: false }),
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: null,
        },
      },
      "pass",
      "ok",
    ],
    [
      "a plan request asked for plan again stays past the window",
      {
        activeRequest: { intent: "plan" },
        intent: "plan",
        policy: delegatedPolicy({ enabled: false }),
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
      "pass",
      "ok",
    ],
    [
      "a start request asked for plan stays past the window",
      {
        activeRequest: { intent: "start" },
        intent: "plan",
        policy: delegatedPolicy({ enabled: false }),
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
      "pass",
      "ok",
    ],
    [
      "a provenance time without an offset is unverified",
      {
        authority: {
          principalActive: true,
          provenance: applied("2026-11-01T00:00:01"),
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "a date-only provenance time is unverified",
      {
        authority: {
          principalActive: true,
          provenance: applied("2026-11-02"),
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "an impossible provenance date is unverified",
      {
        authority: {
          principalActive: true,
          provenance: applied("2026-02-30T00:00:00Z"),
          actorRole: role(),
        },
      },
      "wait",
      "adoption_required",
    ],
    [
      "a provenance time with an offset is compared by instant",
      {
        authority: {
          principalActive: true,
          provenance: applied("2026-10-31T19:00:01-05:00"),
          actorRole: role(),
        },
      },
      "pass",
      "ok",
    ],
  ];
  for (const [name, change, status, reason] of cases) {
    const report = await evaluate(automaticInput(change));
    assertEquals(outcome(report, "intent_authorized"), [status, reason], name);
  }
});

Deno.test("issue 82 unit readiness: a provenance time that is not a timestamp with an offset is unverified and never echoed", async () => {
  for (
    const appliedAt of [
      "2026-11-01T00:00:01",
      "2026-11-01 00:00:01Z",
      "2026-11-01T00:00:01+0100",
      "yesterday",
      "",
      `2026-11-01T00:00:01${"9".repeat(300)}Z`,
      "x".repeat(300),
    ]
  ) {
    const report = await evaluate(automaticInput({
      authority: {
        principalActive: true,
        provenance: applied(appliedAt),
        actorRole: role(),
      },
    }));
    const check = report.checks.find((entry) =>
      entry.id === "intent_authorized"
    );
    assertEquals(
      [check?.status, check?.reason, check?.evidence],
      ["wait", "adoption_required", [{ ref: "label:unverified" }]],
      appliedAt.slice(0, 40),
    );
    assertEquals(report.verdict, "waiting");
  }
});

Deno.test("issue 82 unit readiness: an automatic origin cannot start a plan request outside the window", async () => {
  const plan = { intent: "plan" } as const;
  const outside: [string, Partial<ReadinessInput>][] = [
    [
      "label applied before since",
      {
        authority: {
          principalActive: true,
          provenance: applied(BEFORE),
          actorRole: role(),
        },
      },
    ],
    ["automatic admission switched off", {
      policy: delegatedPolicy({ enabled: false }),
    }],
    ["no since", {
      policy: {
        ...delegatedPolicy(),
        automatic: { enabled: true, since: null },
      },
    }],
  ];
  for (const origin of ["webhook", "poll"] as const) {
    for (const [name, change] of outside) {
      const report = await evaluate(
        automaticInput({ origin, activeRequest: plan, ...change }),
      );
      assertEquals(
        report.verdict,
        "waiting",
        `${origin}, ${name}: an upgrade to start is not ready`,
      );
      assertEquals(
        outcome(report, "intent_authorized"),
        ["wait", "adoption_required"],
        `${origin}, ${name}`,
      );
      assertEquals(
        outcome(report, "no_active_admission"),
        ["pass", "ok"],
        `${origin}, ${name}: the upgrade itself is not refused`,
      );
    }
    const inside = await evaluate(
      automaticInput({ origin, activeRequest: plan }),
    );
    assertEquals(inside.verdict, "ready", `${origin}: inside the window`);
    const same = await evaluate(automaticInput({
      origin,
      activeRequest: plan,
      intent: "plan",
      policy: delegatedPolicy({ enabled: false }),
      authority: {
        principalActive: true,
        provenance: applied(BEFORE),
        actorRole: role(),
      },
    }));
    assertEquals(
      same.verdict,
      "ready",
      `${origin}: a plan request rechecked as plan keeps the request it has`,
    );
  }
  const adoption = await evaluate(automaticInput({
    origin: "adoption",
    activeRequest: plan,
    policy: delegatedPolicy({ enabled: false }),
    authority: {
      principalActive: true,
      provenance: applied(BEFORE),
      actorRole: null,
    },
  }));
  assertEquals(
    adoption.verdict,
    "ready",
    "an explicit adoption may start an earlier labeled plan",
  );
  const manual = await evaluate(readyInput({ activeRequest: plan }));
  assertEquals(manual.verdict, "ready", "a manual start of a plan request");
});

Deno.test("issue 82 unit readiness: automatic admission off or without a since waits on adoption before any provenance read is consulted", async () => {
  const closed: [string, TicketSourcePolicy][] = [
    [
      "switched off with a since",
      delegatedPolicy({ enabled: false, since: SINCE }),
    ],
    ["switched off", delegatedPolicy({ enabled: false })],
    ["on with no since", {
      ...delegatedPolicy(),
      automatic: { enabled: true, since: null },
    }],
  ];
  const provenances: [string, TicketLabelProvenance | null][] = [
    ["applied after since", applied()],
    ["applied before since", applied(BEFORE)],
    ["absent", { kind: "absent" }],
    ["unverifiable", { kind: "unverifiable", reason: "events past the bound" }],
    ["not read", null],
    ["read failed", FAILURE],
  ];
  for (const origin of ["webhook", "poll"] as const) {
    for (const activeRequest of [null, { intent: "plan" } as const]) {
      for (const [policyName, policy] of closed) {
        for (const [provenanceName, provenance] of provenances) {
          const name = `${origin}, ${
            activeRequest?.intent ?? "new"
          }, ${policyName}, provenance ${provenanceName}`;
          const report = await evaluate(automaticInput({
            origin,
            activeRequest,
            policy,
            authority: { principalActive: true, provenance, actorRole: role() },
          }));
          const check = report.checks.find((entry) =>
            entry.id === "intent_authorized"
          );
          // The closed window decides before the provenance read is looked at:
          // an unavailable read is not `provider_unavailable` here.
          assertEquals(
            [check?.status, check?.reason, check?.evidence],
            ["wait", "adoption_required", [{ ref: "automatic:disabled" }]],
            name,
          );
          assertEquals(report.verdict, "waiting", name);
        }
      }
    }
  }
});

Deno.test("issue 82 unit readiness: a ticket with sub-issues is an epic and is rejected", async () => {
  const epic = await evaluate(
    readyInput({ links: presentLinks({ subIssuesTotal: 2 }) }),
  );
  assertEquals(outcome(epic, "epic_excluded"), ["reject", "has_sub_issues"]);
  assertEquals(epic.verdict, "rejected");
  const child = await evaluate(
    readyInput({ links: presentLinks({ parent: ref(1) }) }),
  );
  assertEquals(
    outcome(child, "epic_excluded"),
    ["pass", "ok"],
    "a child is fine",
  );
  for (const links of [null, FAILURE]) {
    const unread = await evaluate(readyInput({ links }));
    assertEquals(outcome(unread, "epic_excluded"), [
      "wait",
      "provider_unavailable",
    ]);
    assertEquals(outcome(unread, "dependencies_satisfied"), [
      "wait",
      "provider_unavailable",
    ]);
    assertEquals(unread.dependencyDigest, null);
    assertEquals(unread.verdict, "waiting");
  }
});

Deno.test("issue 82 unit readiness: a sub-issue count that is not a whole number of at least zero fails closed", async () => {
  for (
    const total of [
      Number.NaN,
      -1,
      -0.5,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
      null,
      "0",
    ]
  ) {
    const report = await evaluate(readyInput({
      links: presentLinks({ subIssuesTotal: total as unknown as number }),
    }));
    assertEquals(
      outcome(report, "epic_excluded"),
      ["wait", "provider_unavailable"],
      `subIssuesTotal ${String(total)}`,
    );
    assertEquals(report.verdict, "waiting", `subIssuesTotal ${String(total)}`);
    assertEquals(
      report.checks.find((check) => check.id === "epic_excluded")?.evidence,
      [{ ref: "sub_issues:invalid" }],
    );
  }
  for (
    const [total, status, reason] of [
      [0, "pass", "ok"],
      [1, "reject", "has_sub_issues"],
      [Number.MAX_SAFE_INTEGER, "reject", "has_sub_issues"],
    ] as const
  ) {
    const report = await evaluate(readyInput({
      links: presentLinks({ subIssuesTotal: total }),
    }));
    assertEquals(outcome(report, "epic_excluded"), [status, reason]);
  }
});

Deno.test("issue 82 unit readiness: origin and label basis must agree, else the admission waits and never reads as ready", async () => {
  const consistent: [string, Partial<ReadinessInput>][] = [
    ["manual with the manual basis", {
      origin: "manual",
      labelBasis: "manual",
      policy: delegatedPolicy(),
    }],
    ["adoption with the label basis", {
      origin: "adoption",
      labelBasis: "label",
    }],
    ["adoption with the manual basis", {
      origin: "adoption",
      labelBasis: "manual",
    }],
    ["webhook with the label basis", {
      origin: "webhook",
      labelBasis: "label",
    }],
    ["poll with the label basis", { origin: "poll", labelBasis: "label" }],
  ];
  for (const [name, change] of consistent) {
    const report = await evaluate(automaticInput(change));
    assertEquals(outcome(report, "authority_live"), ["pass", "ok"], name);
    assertEquals(report.verdict, "ready", name);
  }
  const inconsistent: [string, Partial<ReadinessInput>, string[]][] = [
    ["webhook with the manual basis", {
      origin: "webhook",
      labelBasis: "manual",
    }, ["origin:webhook", "basis:manual"]],
    ["poll with the manual basis", {
      origin: "poll",
      labelBasis: "manual",
    }, ["origin:poll", "basis:manual"]],
    ["manual with the label basis", {
      origin: "manual",
      labelBasis: "label",
    }, ["origin:manual", "basis:label"]],
  ];
  for (const [name, change, refs] of inconsistent) {
    for (const issue of [presentIssue(), presentIssue({ labels: [] })]) {
      const report = await evaluate(automaticInput({ ...change, issue }));
      assertEquals(
        outcome(report, "authority_live"),
        ["wait", "actor_unverifiable"],
        name,
      );
      assertEquals(
        report.checks.find((check) => check.id === "authority_live")?.evidence,
        refs.map((ref) => ({ ref })),
        name,
      );
      assertEquals(report.verdict, "waiting", name);
    }
  }
});

Deno.test("issue 82 unit readiness: acceptance criteria are a heading with a list item in its section", () => {
  const found: [string, string][] = [
    ["bullet", "### Acceptance criteria\n- one"],
    ["star bullet", "## Acceptance criteria\n* one"],
    ["plus bullet", "# Acceptance criteria\n+ one"],
    ["numbered", "### Acceptance criteria\n1. first"],
    ["numbered paren", "### Acceptance criteria\n1) first"],
    ["task item", "### Acceptance criteria\n- [ ] exports a file"],
    ["checked task item", "### Acceptance criteria\n- [x] exports a file"],
    ["any case", "### ACCEPTANCE CRITERIA\n- one"],
    ["colon", "### Acceptance criteria:\n- one"],
    ["bold title", "### **Acceptance criteria**\n- one"],
    ["closing hashes", "### Acceptance criteria ###\n- one"],
    ["after text", "Some intro.\n\n## Acceptance criteria\n\n- one\n- two"],
    ["indented item", "### Acceptance criteria\n  - nested"],
    [
      "deeper heading stays inside",
      "## Acceptance criteria\n### Detail\n- one",
    ],
    ["not the last section", "## Acceptance criteria\n- one\n## Notes\ntext"],
    [
      "three spaces of indentation is still a list",
      "### Acceptance criteria\n   - one",
    ],
    [
      "a real item after an indented code line",
      "### Acceptance criteria\n    - code\n\n- real",
    ],
    [
      "a real item after a four-backtick fence closed by four",
      "### Acceptance criteria\n````\n- one\n````\n- real",
    ],
    [
      "a fence closed by a longer fence",
      "### Acceptance criteria\n```\ncode\n````\n- real",
    ],
    [
      "a tilde fence closed by a longer tilde fence",
      "### Acceptance criteria\n~~~\ncode\n~~~~~\n- real",
    ],
    [
      "a closing fence may be indented up to three spaces",
      "### Acceptance criteria\n```\ncode\n   ```\n- real",
    ],
    [
      "an inline triple-backtick span is not a fence",
      "### Acceptance criteria\n```code```\n- one",
    ],
    [
      "a list after a closed comment",
      "### Acceptance criteria\n<!-- fill this in -->\n- one",
    ],
    [
      "a list after a closed multi-line comment",
      "### Acceptance criteria\n<!--\nfill this in\n-->\n- one",
    ],
    [
      "a list item with text beside a comment",
      "### Acceptance criteria\n- one <!-- note -->",
    ],
    [
      "a heading before a comment",
      "<!-- intro -->\n### Acceptance criteria\n- one",
    ],
    [
      "a comment opener inside a fence is code",
      "### Acceptance criteria\n```\n<!--\n```\n- one",
    ],
    [
      "a fence marker inside a comment opens no fence",
      "### Acceptance criteria\n<!--\n```\n-->\n- one",
    ],
    ["CRLF line endings", "### Acceptance criteria\r\n- one\r\n"],
    ["lone CR line endings", "### Acceptance criteria\r- one\r"],
    [
      "CRLF around a closed fence",
      "### Acceptance criteria\r\n```\r\ncode\r\n```\r\n- real\r\n",
    ],
  ];
  for (const [name, body] of found) {
    assertEquals(hasAcceptanceCriteria(body), true, name);
  }
  const missing: [string, string][] = [
    ["empty body", ""],
    ["no heading", "- one\n- two"],
    ["heading without a list", "### Acceptance criteria\nit works"],
    ["heading with nothing", "### Acceptance criteria"],
    ["list in another section", "### Notes\n- one"],
    ["list before the heading", "- one\n### Acceptance criteria\ntext"],
    ["next section ends it", "### Acceptance criteria\ntext\n### Notes\n- one"],
    ["higher heading ends it", "## Acceptance criteria\ntext\n# Other\n- one"],
    ["empty bullet", "### Acceptance criteria\n- \n-"],
    ["empty task item", "### Acceptance criteria\n- [ ]\n- [x] "],
    ["different title", "### Acceptance\n- one"],
    ["longer title", "### Acceptance criteria met\n- one"],
    ["not a heading", "Acceptance criteria\n- one"],
    ["bare hashes", "###Acceptance criteria\n- one"],
    ["code fence item", "### Acceptance criteria\n```\n- one\n```\ntext"],
    ["code fenced heading", "```\n### Acceptance criteria\n- one\n```"],
    ["tilde fence", "### Acceptance criteria\n~~~\n- one\n~~~"],
    ["number without a dot", "### Acceptance criteria\n1 first"],
    [
      "a shorter inner fence does not close a longer one",
      "### Acceptance criteria\n````\n```\n- one\n```\n````\ntext",
    ],
    [
      "a heading inside a longer fence with an inner fence",
      "````\n```\n### Acceptance criteria\n- one\n```\n````",
    ],
    [
      "a fence of the other character does not close a tilde fence",
      "### Acceptance criteria\n~~~\n```\n- one\n```\n~~~\ntext",
    ],
    [
      "a shorter tilde fence does not close a longer one",
      "### Acceptance criteria\n~~~~\n~~~\n- one\n~~~~\ntext",
    ],
    [
      "a closing fence with an info string closes nothing",
      "### Acceptance criteria\n```\n```js\n- one\n```\ntext",
    ],
    [
      "a closing fence indented four spaces closes nothing",
      "### Acceptance criteria\n```\n    ```\n- one\n```\ntext",
    ],
    [
      "an unclosed fence hides the rest",
      "### Acceptance criteria\n```\n- one",
    ],
    [
      "an item inside a comment",
      "### Acceptance criteria\n<!-- - one -->\ntext",
    ],
    [
      "an item inside a multi-line comment",
      "### Acceptance criteria\n<!--\n- one\n-->\ntext",
    ],
    [
      "a heading inside a comment",
      "<!--\n### Acceptance criteria\n- one\n-->",
    ],
    [
      "an unclosed comment hides the rest",
      "### Acceptance criteria\n<!-- never closed\n- one",
    ],
    [
      "an item that only holds a comment",
      "### Acceptance criteria\n- <!-- later -->",
    ],
    ["an item indented four spaces", "### Acceptance criteria\n    - one"],
    [
      "a numbered item indented four spaces",
      "### Acceptance criteria\n    1. one",
    ],
    ["an item indented by a tab", "### Acceptance criteria\n\t- one"],
    [
      "an item indented by spaces then a tab",
      "### Acceptance criteria\n  \t- one",
    ],
    ["a heading indented four spaces", "    ### Acceptance criteria\n- one"],
    ["a heading indented by a tab", "\t### Acceptance criteria\n- one"],
    [
      "a fenced item with CRLF line endings",
      "### Acceptance criteria\r\n```\r\n- one\r\n```\r\ntext\r\n",
    ],
    [
      "CRLF heading without an item",
      "### Acceptance criteria\r\nit works\r\n",
    ],
  ];
  for (const [name, body] of missing) {
    assertEquals(hasAcceptanceCriteria(body), false, name);
  }
  assertEquals(
    hasAcceptanceCriteria("### Acceptance criteria\n```\ncode\n```\n- real"),
    true,
    "a list after a closed fence counts",
  );
});

Deno.test("issue 82 unit readiness: acceptance_present waits unless the policy does not require criteria", async () => {
  const bare = presentIssue({ body: "Just do it." });
  const required = await evaluate(readyInput({ issue: bare }));
  assertEquals(outcome(required, "acceptance_present"), [
    "wait",
    "acceptance_missing",
  ]);
  assertEquals(required.verdict, "waiting");
  const optional = await evaluate(readyInput({
    issue: bare,
    policy: {
      ...defaultTicketSourcePolicy(),
      readiness: { requireAcceptanceCriteria: false },
    },
  }));
  assertEquals(outcome(optional, "acceptance_present"), ["pass", "ok"]);
  assertEquals(optional.verdict, "ready");
  const crlf = await evaluate(readyInput({
    issue: presentIssue({ body: "### Acceptance criteria\r\n- one\r\n" }),
  }));
  assertEquals(
    outcome(crlf, "acceptance_present"),
    ["pass", "ok"],
    "CRLF body",
  );
});

Deno.test("issue 82 unit readiness: dependencies_satisfied needs a merged-pull-request proof for every blocker", async () => {
  const two = [ref(1), ref(2)];
  const cases: [
    string,
    Partial<Extract<TicketLinksRead, { kind: "present" }>>,
    BlockerProofEntry[],
    string,
    string,
  ][] = [
    ["no blockers", {}, [], "pass", "ok"],
    [
      "all satisfied",
      { blockedBy: two },
      [satisfiedProof(1), satisfiedProof(2)],
      "pass",
      "ok",
    ],
    [
      "one open",
      { blockedBy: two },
      [satisfiedProof(1), entry(2, { kind: "open" })],
      "wait",
      "predecessor_open",
    ],
    [
      "closed unmerged",
      { blockedBy: two },
      [
        satisfiedProof(1),
        entry(2, { kind: "closed_unmerged", stateReason: "not_planned" }),
      ],
      "wait",
      "closed_unmerged",
    ],
    [
      "other repository",
      { blockedBy: two },
      [satisfiedProof(1), entry(2, { kind: "inaccessible" })],
      "wait",
      "inaccessible",
    ],
    [
      "proof not provable",
      { blockedBy: two },
      [
        satisfiedProof(1),
        entry(2, { kind: "proof_unavailable", detail: "events" }),
      ],
      "wait",
      "proof_unavailable",
    ],
    [
      "proof missing",
      { blockedBy: two },
      [satisfiedProof(1)],
      "wait",
      "proof_unavailable",
    ],
    [
      "proof read failed",
      { blockedBy: two },
      [satisfiedProof(1), entry(2, FAILURE)],
      "wait",
      "provider_unavailable",
    ],
    [
      "list truncated",
      { blockedBy: two, truncated: true },
      [satisfiedProof(1), satisfiedProof(2)],
      "wait",
      "links_truncated",
    ],
    [
      "open beats closed beats inaccessible",
      { blockedBy: [ref(1), ref(2), ref(3)] },
      [
        entry(1, { kind: "inaccessible" }),
        entry(2, { kind: "closed_unmerged", stateReason: null }),
        entry(3, { kind: "open" }),
      ],
      "wait",
      "predecessor_open",
    ],
    [
      "a known open blocker beats truncation",
      { blockedBy: two, truncated: true },
      [satisfiedProof(1), entry(2, { kind: "open" })],
      "wait",
      "predecessor_open",
    ],
    [
      "truncation beats an unprovable proof",
      { blockedBy: two, truncated: true },
      [satisfiedProof(1), entry(2, { kind: "proof_unavailable", detail: "x" })],
      "wait",
      "links_truncated",
    ],
  ];
  for (const [name, links, proofs, status, reason] of cases) {
    const report = await evaluate(
      readyInput({ links: presentLinks(links), proofs }),
    );
    assertEquals(
      outcome(report, "dependencies_satisfied"),
      [status, reason],
      name,
    );
  }
  const many = Array.from({ length: 8 }, (_, index) => ref(index + 1));
  const crowded = await evaluate(readyInput({
    links: presentLinks({ blockedBy: many }),
    proofs: many.map((blocker) => ({
      blocker,
      proof: { kind: "open" } as const,
    })),
  }));
  const check = crowded.checks.find((entry) =>
    entry.id === "dependencies_satisfied"
  );
  assertEquals(
    check?.evidence.length,
    TICKET_CHECK_MAX_EVIDENCE,
    "evidence is bounded",
  );
});

Deno.test("issue 82 unit readiness: no_active_admission passes for the same intent and for a plan upgrade only", async () => {
  const cases: [
    string,
    ReadinessInput["activeRequest"],
    ReadinessInput["intent"],
    string,
    string,
  ][] = [
    ["nothing active", null, "start", "pass", "ok"],
    ["same start", { intent: "start" }, "start", "pass", "ok"],
    ["same plan", { intent: "plan" }, "plan", "pass", "ok"],
    ["plan upgrades to start", { intent: "plan" }, "start", "pass", "ok"],
    [
      "start active, plan asked",
      { intent: "start" },
      "plan",
      "wait",
      "active_request",
    ],
    ["no intent asked", { intent: "start" }, null, "pass", "ok"],
  ];
  for (const [name, activeRequest, intent, status, reason] of cases) {
    const report = await evaluate(readyInput({ activeRequest, intent }));
    assertEquals(
      outcome(report, "no_active_admission"),
      [status, reason],
      name,
    );
  }
});

Deno.test("issue 82 unit readiness: repository and preset readiness", async () => {
  const source = readyInput().source;
  const archived = await evaluate(
    readyInput({ source: { ...source, repositoryArchived: true } }),
  );
  assertEquals(outcome(archived, "repository_ready"), [
    "wait",
    "repository_archived",
  ]);
  const noProfile = await evaluate(
    readyInput({ source: { ...source, repositoryHasActiveProfile: false } }),
  );
  assertEquals(outcome(noProfile, "repository_ready"), [
    "wait",
    "no_active_profile",
  ]);
  const both = await evaluate(readyInput({
    source: {
      ...source,
      repositoryArchived: true,
      repositoryHasActiveProfile: false,
    },
  }));
  assertEquals(outcome(both, "repository_ready"), [
    "wait",
    "repository_archived",
  ]);
  const preset = await evaluate(
    readyInput({ source: { ...source, presetReady: false } }),
  );
  assertEquals(outcome(preset, "preset_ready"), [
    "wait",
    "preset_setup_required",
  ]);
  assertEquals(preset.verdict, "waiting");
});

Deno.test("issue 82 unit readiness: authority_live for a manual caller", async () => {
  const live = await evaluate(readyInput());
  assertEquals(outcome(live, "authority_live"), ["pass", "ok"]);
  const gone = await evaluate(readyInput({
    authority: { principalActive: false, provenance: null, actorRole: null },
  }));
  assertEquals(outcome(gone, "authority_live"), ["wait", "principal_inactive"]);
  assertEquals(gone.verdict, "waiting");
  const adoption = await evaluate(readyInput({
    origin: "adoption",
    policy: delegatedPolicy(),
  }));
  assertEquals(
    outcome(adoption, "authority_live"),
    ["pass", "ok"],
    "adoption acts as its caller",
  );
});

Deno.test("issue 82 unit readiness: authority_live for a delegated admission checks principal, allowlist and role", async () => {
  const auth = (
    provenance: TicketLabelProvenance | null,
    actorRole: TicketActorRole | null,
    principalActive = true,
  ) => ({ principalActive, provenance, actorRole });
  const cases: [string, Partial<ReadinessInput>, string, string][] = [
    ["allowlisted writer", {}, "pass", "ok"],
    ["admin", { authority: auth(applied(), role("admin")) }, "pass", "ok"],
    [
      "second allowlisted actor",
      { authority: auth(applied(AFTER, "1002"), role("write", "1002")) },
      "pass",
      "ok",
    ],
    ["poll origin", { origin: "poll" }, "pass", "ok"],
    [
      "no delegation",
      { policy: defaultTicketSourcePolicy() },
      "wait",
      "no_delegation",
    ],
    [
      "inactive principal",
      { authority: auth(applied(), role(), false) },
      "wait",
      "principal_inactive",
    ],
    [
      "no delegation outranks an inactive principal",
      {
        policy: defaultTicketSourcePolicy(),
        authority: auth(applied(), role(), false),
      },
      "wait",
      "no_delegation",
    ],
    [
      "actor not allowlisted",
      { authority: auth(applied(AFTER, "7777"), role("write", "7777")) },
      "wait",
      "actor_not_allowlisted",
    ],
    [
      "read role",
      { authority: auth(applied(), role("read")) },
      "wait",
      "actor_role_insufficient",
    ],
    [
      "no role",
      { authority: auth(applied(), role("none")) },
      "wait",
      "actor_role_insufficient",
    ],
    [
      "role of another user",
      { authority: auth(applied(), role("write", "2002")) },
      "wait",
      "actor_unverifiable",
    ],
    [
      "role absent",
      { authority: auth(applied(), { kind: "absent" }) },
      "wait",
      "actor_unverifiable",
    ],
    [
      "role not read",
      { authority: auth(applied(), null) },
      "wait",
      "actor_unverifiable",
    ],
    [
      "role read failed",
      { authority: auth(applied(), FAILURE) },
      "wait",
      "provider_unavailable",
    ],
    [
      "provenance absent",
      { authority: auth({ kind: "absent" }, null) },
      "wait",
      "actor_unverifiable",
    ],
    [
      "provenance unverifiable",
      { authority: auth({ kind: "unverifiable", reason: "page bound" }, null) },
      "wait",
      "actor_unverifiable",
    ],
    [
      "provenance not read",
      { authority: auth(null, null) },
      "wait",
      "actor_unverifiable",
    ],
    [
      "provenance read failed",
      { authority: auth(FAILURE, null) },
      "wait",
      "provider_unavailable",
    ],
    [
      "issue unreadable and provenance not read",
      { issue: FAILURE, authority: auth(null, null) },
      "wait",
      "provider_unavailable",
    ],
  ];
  for (const [name, change, status, reason] of cases) {
    const report = await evaluate(automaticInput(change));
    assertEquals(outcome(report, "authority_live"), [status, reason], name);
  }
});

Deno.test("issue 82 unit readiness: a pinned digest that differs gives requirements_unchanged wait acceptance_changed while criteria are still present", async () => {
  const pinned = await requirementsDigest(
    normalizeSnapshot(issueSnapshot({ title: "Old title" }), {
      links: null,
      providerUpdatedAt: MARKER,
    }),
  );
  const report = await evaluate(
    readyInput({ pinnedRequirementsDigest: pinned }),
  );
  assertEquals(
    outcome(report, "acceptance_present"),
    ["pass", "ok"],
    "criteria remain",
  );
  assertEquals(outcome(report, "requirements_unchanged"), [
    "wait",
    "acceptance_changed",
  ]);
  assertEquals(report.verdict, "waiting");
  const check = report.checks.find((entry) =>
    entry.id === "requirements_unchanged"
  );
  assertEquals(check?.evidence.map((item) => item.ref), [
    "requirements:pinned",
    "requirements:live",
  ]);
  assertEquals(check?.evidence[0].digest, pinned);

  const unreadable = await evaluate(
    readyInput({ issue: FAILURE, pinnedRequirementsDigest: pinned }),
  );
  assertEquals(outcome(unreadable, "requirements_unchanged"), [
    "wait",
    "provider_unavailable",
  ]);

  const noPin = await evaluate(readyInput({ pinnedRequirementsDigest: null }));
  assertEquals(
    outcome(noPin, "requirements_unchanged"),
    undefined,
    "no pin, no check",
  );
});

Deno.test("issue 82 unit readiness: a provider failure never passes a check and yields wait provider_unavailable", async () => {
  const unreadable = await evaluate(readyInput({
    issue: FAILURE,
    links: null,
    labelBasis: "label",
    origin: "adoption",
    pinnedRequirementsDigest: "a".repeat(64),
  }));
  assertEquals(unreadable.verdict, "waiting");
  for (
    const id of [
      "ticket_supported",
      "not_held",
      "intent_authorized",
      "epic_excluded",
      "acceptance_present",
      "dependencies_satisfied",
      "requirements_unchanged",
    ] as const
  ) {
    assertEquals(outcome(unreadable, id), ["wait", "provider_unavailable"], id);
  }
  for (
    const id of [
      "source_live",
      "no_active_admission",
      "repository_ready",
      "preset_ready",
      "authority_live",
    ] as const
  ) {
    assertEquals(
      outcome(unreadable, id),
      ["pass", "ok"],
      `${id} needs no read`,
    );
  }
  assertEquals(unreadable.requirementsDigest, null);
  assertEquals(unreadable.dependencyDigest, null);
  for (
    const reason of [
      "rate_limited",
      "forbidden",
      "provider_error",
      "timeout",
      "labels_truncated",
    ] as const
  ) {
    const report = await evaluate(readyInput({
      issue: { kind: "unavailable", reason, retryAfterSeconds: null },
    }));
    const check = report.checks.find((entry) =>
      entry.id === "ticket_supported"
    );
    assertEquals(check?.evidence, [{ ref: `provider:${reason}` }]);
  }
});

Deno.test("issue 82 unit readiness: a cut label list waits as provider_unavailable under its own evidence, never passes, and still suspends a running request", async () => {
  const cut: TicketReadFailure = {
    kind: "unavailable",
    reason: "labels_truncated",
    retryAfterSeconds: null,
  };
  const pinned = "a".repeat(64);
  const report = await evaluate(readyInput({
    issue: cut,
    labelBasis: "label",
    origin: "adoption",
    pinnedRequirementsDigest: pinned,
  }));
  assertEquals(report.verdict, "waiting");
  for (
    const id of [
      "ticket_supported",
      "not_held",
      "intent_authorized",
      "epic_excluded",
      "acceptance_present",
      "dependencies_satisfied",
      "requirements_unchanged",
    ] as const
  ) {
    const found = report.checks.find((entry) => entry.id === id);
    assertEquals(
      [found?.status, found?.reason],
      ["wait", "provider_unavailable"],
      id,
    );
    // The evidence names the cut list, not an outage of the provider.
    assertEquals(found?.evidence, [{ ref: "provider:labels_truncated" }], id);
  }
  assertEquals(
    report.checks.some((check) =>
      check.evidence.some((entry) => entry.ref === "provider:provider_error")
    ),
    false,
  );

  // A recheck decides on it as on any other provider failure.
  const running: RecheckCurrent = {
    disposition: "active",
    dispositionReason: null,
    intent: "start",
    hasRun: true,
    runStatus: "running",
    taskStatus: "active",
    approvalAvailable: false,
    pinnedRequirementsDigest: pinned,
    pauseRequestedAt: null,
  };
  assertEquals(decideRecheck(running, report), {
    action: "suspend",
    reason: "provider_unavailable",
  });
  assertEquals(
    decideRecheck(
      {
        ...running,
        disposition: "suspended",
        dispositionReason: "provider_unavailable",
      },
      report,
    ),
    { action: "pause" },
    "the suspended request's run is paused once",
  );
});

Deno.test("issue 82 unit readiness: the verdict is ready only when every check passes, rejected when any rejects", async () => {
  const wait = await evaluate(
    readyInput({
      issue: presentIssue({ labels: ["ready for agent", "bakery:hold"] }),
    }),
  );
  assertEquals(wait.verdict, "waiting");
  const reject = await evaluate(
    readyInput({ links: presentLinks({ subIssuesTotal: 1 }) }),
  );
  assertEquals(reject.verdict, "rejected");
  const both = await evaluate(readyInput({
    issue: presentIssue({
      labels: ["ready for agent", "bakery:hold"],
      state: "closed",
    }),
  }));
  assertEquals(outcome(both, "not_held"), ["wait", "held"]);
  assertEquals(outcome(both, "ticket_supported"), ["reject", "ticket_closed"]);
  assertEquals(both.verdict, "rejected", "a reject outranks a wait");
});

Deno.test("issue 82 unit readiness: the basis digest follows the verdict inputs and nothing else", async () => {
  const base = await evaluate(readyInput());
  assertEquals(
    (await evaluate(readyInput())).basisDigest,
    base.basisDigest,
    "a repeat",
  );
  const sameBasis = [
    readyInput({
      issue: presentIssue({ labels: ["ready for agent", "bug", "p1"] }),
    }),
    readyInput({ issue: presentIssue({ locked: true }) }),
    readyInput({ issue: presentIssue({}, "2027-05-05T00:00:00Z") }),
    readyInput({
      issue: presentIssue({ body: CRITERIA_BODY.replace("\n", "\r\n") }),
    }),
  ];
  for (const input of sameBasis) {
    assertEquals(
      (await evaluate(input)).basisDigest,
      base.basisDigest,
      "an edit outside the title and body, or a repeat with other label noise, is no new basis",
    );
  }
  const differs: [string, ReadinessInput][] = [
    ["title", readyInput({ issue: presentIssue({ title: "Another title" }) })],
    [
      "body",
      readyInput({ issue: presentIssue({ body: `${CRITERIA_BODY}- more\n` }) }),
    ],
    [
      "hold",
      readyInput({
        issue: presentIssue({ labels: ["ready for agent", "bakery:hold"] }),
      }),
    ],
    ["closed", readyInput({ issue: presentIssue({ state: "closed" }) })],
    ["policy revision", readyInput({ policyRevision: 4 })],
    ["preset", readyInput({ preset: { ...PRESET, revision: 2 } })],
    ["intent", readyInput({ intent: "plan" })],
    [
      "label basis",
      readyInput({ labelBasis: "label", origin: "adoption" }),
    ],
    [
      "authority lost",
      readyInput({
        authority: {
          principalActive: false,
          provenance: null,
          actorRole: null,
        },
      }),
    ],
    [
      "source disabled",
      readyInput({ source: { ...readyInput().source, enabled: false } }),
    ],
    [
      "blocker added",
      readyInput({
        links: presentLinks({ blockedBy: [ref(1)] }),
        proofs: [satisfiedProof(1)],
      }),
    ],
    ["provider unavailable", readyInput({ issue: FAILURE })],
  ];
  const seen = new Set([base.basisDigest]);
  for (const [name, input] of differs) {
    const report = await evaluate(input);
    assertNotEquals(report.basisDigest, base.basisDigest, name);
    seen.add(report.basisDigest);
  }
  assertEquals(seen.size, differs.length + 1, "no two variants share a basis");
});

Deno.test("issue 82 unit readiness: a link change moves the dependency digest and the basis, not the requirements digest", async () => {
  const before = await evaluate(readyInput());
  const after = await evaluate(readyInput({
    links: presentLinks({ blockedBy: [ref(7)] }),
    proofs: [satisfiedProof(7)],
  }));
  assertEquals(after.requirementsDigest, before.requirementsDigest);
  assertNotEquals(after.dependencyDigest, before.dependencyDigest);
  assertNotEquals(after.basisDigest, before.basisDigest);
  const edited = await evaluate(
    readyInput({ issue: presentIssue({ title: "Renamed" }) }),
  );
  assertNotEquals(edited.requirementsDigest, before.requirementsDigest);
  assertEquals(edited.dependencyDigest, before.dependencyDigest);
});

Deno.test("issue 82 unit readiness: a too-large issue is tracked by its provider marker", async () => {
  const large = (marker: string) =>
    evaluate(
      readyInput({
        issue: presentIssue({ body: "", bodyTooLarge: true }, marker),
      }),
    );
  const first = await large(MARKER);
  const second = await large("2027-01-01T00:00:00Z");
  assertEquals(first.requirementsDigest, null);
  assertNotEquals(first.basisDigest, second.basisDigest);
  assertEquals((await large(MARKER)).basisDigest, first.basisDigest);
});

Deno.test("issue 82 unit readiness: across every origin, basis, request and window state, an automatic admission of new work is ready only inside the window", async () => {
  type Window = {
    name: string;
    policy: TicketSourcePolicy;
    provenance: TicketLabelProvenance | null;
    inside: boolean;
  };
  const noSince: TicketSourcePolicy = {
    ...delegatedPolicy(),
    automatic: { enabled: true, since: null },
  };
  const windows: Window[] = [
    {
      name: "inside",
      policy: delegatedPolicy(),
      provenance: applied(AFTER),
      inside: true,
    },
    {
      name: "at since",
      policy: delegatedPolicy(),
      provenance: applied(SINCE),
      inside: true,
    },
    {
      name: "label before since",
      policy: delegatedPolicy(),
      provenance: applied(BEFORE),
      inside: false,
    },
    {
      name: "switch off",
      policy: delegatedPolicy({ enabled: false, since: SINCE }),
      provenance: applied(AFTER),
      inside: false,
    },
    {
      name: "switch off, no since",
      policy: delegatedPolicy({ enabled: false }),
      provenance: applied(AFTER),
      inside: false,
    },
    {
      name: "enabled, no since",
      policy: noSince,
      provenance: applied(AFTER),
      inside: false,
    },
    {
      name: "label time without offset",
      policy: delegatedPolicy(),
      provenance: applied("2026-11-01T00:00:01"),
      inside: false,
    },
    {
      name: "provenance absent",
      policy: delegatedPolicy(),
      provenance: { kind: "absent" },
      inside: false,
    },
    {
      name: "provenance not read",
      policy: delegatedPolicy(),
      provenance: null,
      inside: false,
    },
  ];
  const requests: ReadinessInput["activeRequest"][] = [
    null,
    { intent: "plan" },
    { intent: "start" },
  ];
  let readyAutomatic = 0;
  let cells = 0;
  for (const origin of ["manual", "adoption", "webhook", "poll"] as const) {
    for (const labelBasis of ["label", "manual"] as const) {
      for (const activeRequest of requests) {
        for (const intent of [null, "plan", "start"] as const) {
          for (const window of windows) {
            const input = automaticInput({
              origin,
              labelBasis,
              activeRequest,
              intent,
              policy: window.policy,
              authority: {
                principalActive: true,
                provenance: window.provenance,
                actorRole: role(),
              },
            });
            const report = await evaluate(input);
            cells += 1;
            if (report.verdict !== "ready") continue;
            const name = `${origin}/${labelBasis}, request ${
              activeRequest?.intent ?? "none"
            }, asks ${intent}, ${window.name}`;
            if (origin === "webhook" || origin === "poll") {
              readyAutomatic += 1;
              assertEquals(
                labelBasis,
                "label",
                `${name}: automatic needs the label basis`,
              );
              const newWork = activeRequest === null ||
                (activeRequest.intent === "plan" && intent === "start");
              if (newWork) {
                assertEquals(
                  window.inside,
                  true,
                  `${name}: an automatic admission of new work needs the window`,
                );
              }
            }
            if (origin === "manual") {
              assertEquals(
                labelBasis,
                "manual",
                `${name}: manual has no label basis`,
              );
            }
          }
        }
      }
    }
  }
  assertEquals(cells, 4 * 2 * 3 * 3 * windows.length);
  assert(readyAutomatic > 0, "the grid reaches ready automatic reports");
});

// ---------------------------------------------------------------------------
// Property run: random inputs from a fixed seed hold the report invariants.

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random input: a clean request for a random origin, with each dimension
 * changed at random with a small probability, so the run reaches every verdict
 * and mostly single-cause failures.
 */
function randomInput(random: () => number): ReadinessInput {
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  const chance = (probability: number) => random() < probability;
  const failure = (): TicketReadFailure => ({
    kind: "unavailable",
    reason: pick(
      [
        "rate_limited",
        "forbidden",
        "provider_error",
        "timeout",
        "labels_truncated",
      ] as const,
    ),
    retryAfterSeconds: chance(0.5) ? 10 : null,
  });
  const flip = (probability = 0.08) => chance(probability);

  const origin = pick(["manual", "adoption", "webhook", "poll"] as const);
  const automatic = origin === "webhook" || origin === "poll";
  const labelBasis = automatic
    ? "label"
    : origin === "adoption"
    ? pick(["label", "manual"] as const)
    : "manual";

  const labels = flip(0.3)
    ? [
      ...(chance(0.6) ? ["ready for agent"] : []),
      ...(chance(0.3) ? ["ready for planning"] : []),
      ...(chance(0.4) ? ["bakery:hold"] : []),
      ...(chance(0.3) ? ["bug"] : []),
    ]
    : ["ready for agent"];
  const kind = flip(0.2)
    ? pick(["unavailable", "gone", "moved", "pull_request"] as const)
    : "present";
  const issue: TicketIssueRead = kind === "present"
    ? presentIssue(
      {
        labels,
        body: flip(0.15)
          ? pick([
            "no criteria here",
            "### Acceptance criteria\ntext only",
            "### Acceptance criteria\n1. one\n2. two",
          ])
          : CRITERIA_BODY,
        bodyTooLarge: flip(0.04),
        state: flip() ? "closed" : "open",
        repositoryFullName: flip(0.04) ? "owner/other" : "owner/repo",
        title: `Title ${Math.floor(random() * 3)}`,
      },
      chance(0.5) ? MARKER : "2027-01-01T00:00:00Z",
    )
    : kind === "unavailable"
    ? failure()
    : { kind };

  const blockers = Array.from(
    { length: flip(0.4) ? 1 + Math.floor(random() * 3) : 0 },
    (_, index) => ref(index + 1),
  );
  const links: TicketLinksRead | null = flip(0.12)
    ? (chance(0.5) ? failure() : null)
    : presentLinks({
      blockedBy: blockers,
      subIssuesTotal: flip() ? 2 : 0,
      truncated: flip(),
    });
  const proofs: BlockerProofEntry[] = [];
  for (const blocker of blockers) {
    if (flip(0.05)) continue;
    proofs.push({
      blocker,
      proof: flip(0.35)
        ? pick([
          { kind: "open" } as const,
          { kind: "closed_unmerged", stateReason: null } as const,
          { kind: "inaccessible" } as const,
          { kind: "proof_unavailable", detail: "x" } as const,
          failure(),
        ])
        : {
          kind: "satisfied",
          pullRequestNumber: 5,
          mergeSha: "a".repeat(40),
          mergedAt: MARKER,
        },
    });
  }

  const provenance: TicketLabelProvenance | null = flip(0.2)
    ? pick([
      null,
      applied(BEFORE),
      applied(AFTER, "7777"),
      { kind: "absent" } as const,
      { kind: "unverifiable", reason: "x" } as const,
      failure(),
    ])
    : applied();
  const actorRole: TicketActorRole | null = flip(0.2)
    ? pick([
      null,
      role("read"),
      role("none"),
      role("write", "2002"),
      { kind: "absent" } as const,
      failure(),
    ])
    : role(pick(["admin", "write"] as const));

  return {
    source: {
      enabled: !flip(0.03),
      connectionEnabled: !flip(0.03),
      installationEnabled: !flip(0.03),
      resourceSelected: !flip(0.03),
      repositoryFullName: "owner/repo",
      repositoryArchived: flip(0.03),
      repositoryHasActiveProfile: !flip(0.03),
      presetReady: !flip(0.03),
    },
    policy: automatic || chance(0.4)
      ? delegatedPolicy({ enabled: !flip(0.15) })
      : defaultTicketSourcePolicy(),
    policyRevision: 1 + Math.floor(random() * 3),
    preset: PRESET,
    issue,
    links,
    proofs,
    authority: { principalActive: !flip(0.05), provenance, actorRole },
    activeRequest: flip(0.25)
      ? { intent: pick(["plan", "start"] as const) }
      : null,
    intent: flip(0.2) ? pick([null, "plan", "start"] as const) : "start",
    origin,
    labelBasis,
    pinnedRequirementsDigest: flip(0.2)
      ? pick(["a".repeat(64), "b".repeat(64)])
      : null,
  };
}

Deno.test("issue 82 unit readiness: property run over random inputs (seed 82) holds the report invariants", async () => {
  const random = mulberry32(82);
  const orderOf = (id: TicketCheckId) => TICKET_CHECK_IDS.indexOf(id);
  const verdicts = new Set<string>();
  let ready = 0;
  for (let round = 0; round < 400; round++) {
    const input = randomInput(random);
    const report = await evaluate(input);
    const label = `round ${round}`;
    verdicts.add(report.verdict);
    if (report.verdict === "ready") ready += 1;

    assertEquals(
      report.verdict === "ready",
      report.checks.every((check) => check.status === "pass"),
      `${label}: ready iff every check passes`,
    );
    assertEquals(
      report.verdict === "rejected",
      report.checks.some((check) => check.status === "reject"),
      `${label}: rejected iff some check rejects`,
    );
    const ids = report.checks.map((check) => check.id);
    assertEquals(
      new Set(ids).size,
      ids.length,
      `${label}: one entry per check`,
    );
    assertEquals(
      ids,
      [...ids].sort((left, right) => orderOf(left) - orderOf(right)),
      `${label}: contract order`,
    );
    for (const check of report.checks) {
      assertEquals(
        check.status === "pass",
        check.reason === "ok",
        `${label}: ${check.id} carries ok exactly when it passes`,
      );
      assert(
        check.reason === "ok" ||
          TICKET_CHECK_REASONS[check.id].includes(check.reason),
        `${label}: ${check.id} may not emit ${check.reason}`,
      );
    }
    assertEquals(
      JSON.stringify(await evaluateReadiness(input)),
      JSON.stringify(report),
      `${label}: deterministic`,
    );

    if (input.issue.kind === "unavailable") {
      for (const check of report.checks) {
        if (
          [
            "ticket_supported",
            "not_held",
            "intent_authorized",
            "epic_excluded",
            "acceptance_present",
            "dependencies_satisfied",
            "requirements_unchanged",
          ].includes(check.id)
        ) {
          assertEquals(
            [check.status, check.reason],
            ["wait", "provider_unavailable"],
            `${label}: ${check.id} with an unreadable issue`,
          );
        }
      }
      assertEquals(report.verdict === "ready", false);
    }
    if (
      input.issue.kind === "present" &&
      (input.links === null || input.links.kind === "unavailable")
    ) {
      assertEquals(outcome(report, "epic_excluded"), [
        "wait",
        "provider_unavailable",
      ], label);
      assertEquals(outcome(report, "dependencies_satisfied"), [
        "wait",
        "provider_unavailable",
      ], label);
      assertEquals(report.dependencyDigest, null, label);
    }
    if (["gone", "moved", "pull_request"].includes(input.issue.kind)) {
      assertEquals(report.verdict, "rejected", label);
    }
    if (report.verdict === "ready") {
      assertEquals(input.issue.kind, "present", label);
      const { source } = input;
      assert(
        source.enabled && source.connectionEnabled &&
          source.installationEnabled && source.resourceSelected &&
          !source.repositoryArchived && source.repositoryHasActiveProfile &&
          source.presetReady,
        label,
      );
      assertEquals(input.authority.principalActive, true, label);
    }
  }
  assertEquals(
    [...verdicts].sort(),
    ["ready", "rejected", "waiting"],
    "the seed exercises every verdict",
  );
  assert(ready >= 20, `the seed reaches ready ${ready} times`);
});
