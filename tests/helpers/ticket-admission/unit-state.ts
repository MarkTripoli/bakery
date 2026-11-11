import { assert, assertEquals } from "@std/assert";
import {
  isNonterminalTicketDisposition,
  isTerminalTicketDisposition,
  NONTERMINAL_TICKET_DISPOSITIONS,
  TERMINAL_TICKET_DISPOSITIONS,
  TICKET_AUTO_RESUMABLE_REASONS,
  TICKET_CHECK_IDS,
  TICKET_CHECK_REASONS,
  TICKET_EXPLICIT_RESUME_REASONS,
  TICKET_NON_SUSPENDING_REASONS,
  TICKET_REASON_CODES,
  TICKET_REQUEST_DISPOSITIONS,
  ticketVerdictFromChecks,
} from "../../../packages/contracts/src/ticket-admission.ts";
import type {
  TicketCheckId,
  TicketReadinessCheck,
  TicketReasonCode,
  TicketRequestDisposition,
} from "../../../packages/contracts/src/ticket-admission.ts";
import {
  canTransition,
  decideRecheck,
  type RecheckCurrent,
  type RecheckDecision,
  suspensionReason,
  type TicketResumeTarget,
} from "../../../apps/server/src/modules/work/ticket-request-state.ts";

/**
 * Issue 82 unit lane: the disposition machine. Legal moves are a fixed table,
 * a recheck suspends on the first suspending reason, resumes only for the
 * auto-resumable reasons, and every reason a check can emit has a defined
 * decision.
 */

const PIN = "a".repeat(64);

function current(overrides: Partial<RecheckCurrent> = {}): RecheckCurrent {
  return {
    disposition: "waiting",
    dispositionReason: null,
    intent: "start",
    hasRun: false,
    runStatus: null,
    taskStatus: "draft",
    approvalAvailable: false,
    pinnedRequirementsDigest: PIN,
    pauseRequestedAt: null,
    ...overrides,
  };
}

function check(
  id: TicketCheckId,
  status: "pass" | "wait" | "reject",
  reason: TicketReasonCode,
): TicketReadinessCheck {
  return { id, status, reason, evidence: [] };
}

const PASS = (id: TicketCheckId) => check(id, "pass", "ok");

/** A report from checks; the pin check passes unless the checks name it. */
function report(
  checks: TicketReadinessCheck[],
  options: { pinChecked?: boolean } = {},
) {
  const all = options.pinChecked === false ||
      checks.some((entry) => entry.id === "requirements_unchanged")
    ? checks
    : [...checks, PASS("requirements_unchanged")];
  return { verdict: ticketVerdictFromChecks(all), checks: all };
}

const READY = report([PASS("source_live"), PASS("not_held")]);

// ---------------------------------------------------------------------------
// canTransition

const ALLOWED: Record<TicketRequestDisposition, TicketRequestDisposition[]> = {
  pending: ["waiting", "admitted", "rejected", "failed", "canceled"],
  waiting: [
    "admitted",
    "active",
    "suspended",
    "rejected",
    "completed",
    "failed",
    "canceled",
  ],
  admitted: ["active", "suspended", "completed", "failed", "canceled"],
  active: ["suspended", "completed", "failed", "canceled"],
  suspended: [
    "waiting",
    "admitted",
    "active",
    "rejected",
    "completed",
    "failed",
    "canceled",
  ],
  rejected: [],
  completed: [],
  failed: [],
  canceled: [],
};

Deno.test("issue 82 unit state: canTransition matches the legal move table for every pair", () => {
  let allowed = 0;
  for (const from of TICKET_REQUEST_DISPOSITIONS) {
    for (const to of TICKET_REQUEST_DISPOSITIONS) {
      const expected = ALLOWED[from].includes(to);
      assertEquals(canTransition(from, to), expected, `${from} -> ${to}`);
      if (expected) allowed += 1;
    }
  }
  assert(allowed > 0);
});

Deno.test("issue 82 unit state: terminal dispositions never move, nothing returns to pending or stays put", () => {
  for (const from of TERMINAL_TICKET_DISPOSITIONS) {
    for (const to of TICKET_REQUEST_DISPOSITIONS) {
      assertEquals(canTransition(from, to), false, `${from} -> ${to}`);
    }
  }
  for (const from of TICKET_REQUEST_DISPOSITIONS) {
    assertEquals(canTransition(from, "pending"), false, `${from} -> pending`);
    assertEquals(canTransition(from, from), false, `${from} -> ${from}`);
  }
});

Deno.test("issue 82 unit state: illegal moves a recheck must never make", () => {
  const illegal: [TicketRequestDisposition, TicketRequestDisposition][] = [
    ["admitted", "waiting"],
    ["active", "waiting"],
    ["active", "admitted"],
    ["pending", "active"],
    ["pending", "suspended"],
    ["pending", "completed"],
    ["admitted", "rejected"],
    ["active", "rejected"],
    ["completed", "waiting"],
    ["canceled", "admitted"],
    ["failed", "suspended"],
    ["rejected", "waiting"],
  ];
  for (const [from, to] of illegal) {
    assertEquals(canTransition(from, to), false, `${from} -> ${to}`);
  }
  for (const from of NONTERMINAL_TICKET_DISPOSITIONS) {
    if (from !== "suspended") {
      assertEquals(canTransition(from, "suspended"), true);
    }
  }
});

// ---------------------------------------------------------------------------
// decideRecheck

Deno.test("issue 82 unit state: a ready report leaves admitted and active requests alone", () => {
  for (const disposition of ["admitted", "active"] as const) {
    assertEquals(
      decideRecheck(
        current({
          disposition,
          hasRun: true,
          runStatus: "running",
          approvalAvailable: true,
        }),
        READY,
      ),
      { action: "none" },
      disposition,
    );
  }
});

Deno.test("issue 82 unit state: a ready waiting request advances only with an approved plan, a start intent and a checked pin", () => {
  const advance = { action: "advance" };
  assertEquals(
    decideRecheck(current({ approvalAvailable: true }), READY),
    advance,
  );
  assertEquals(
    decideRecheck(current(), READY),
    { action: "none" },
    "no approval",
  );
  assertEquals(
    decideRecheck(current({ approvalAvailable: true, intent: "plan" }), READY),
    { action: "none" },
    "a plan request never starts a run",
  );
  assertEquals(
    decideRecheck(
      current({ approvalAvailable: true }),
      report([PASS("source_live")], { pinChecked: false }),
    ),
    { action: "none" },
    "a report that did not check the pin cannot advance a pinned request",
  );
  assertEquals(
    decideRecheck(
      current({ approvalAvailable: true, pinnedRequirementsDigest: null }),
      report([PASS("source_live")], { pinChecked: false }),
    ),
    advance,
    "no pin, nothing to check",
  );
});

Deno.test("issue 82 unit state: a request that is not ready suspends with the first non-pass reason", () => {
  for (const disposition of ["waiting", "admitted", "active"] as const) {
    assertEquals(
      decideRecheck(
        current({ disposition }),
        report([PASS("source_live"), check("not_held", "wait", "held")]),
      ),
      { action: "suspend", reason: "held" },
      disposition,
    );
  }
  assertEquals(
    decideRecheck(
      current(),
      report([
        check("ticket_supported", "reject", "ticket_closed"),
        check("not_held", "wait", "held"),
        check("authority_live", "wait", "principal_inactive"),
      ]),
    ),
    { action: "suspend", reason: "ticket_closed" },
    "report order decides",
  );
  assertEquals(
    decideRecheck(
      current(),
      report([
        PASS("source_live"),
        check("ticket_supported", "wait", "provider_unavailable"),
      ]),
    ),
    { action: "suspend", reason: "provider_unavailable" },
  );
});

Deno.test("issue 82 unit state: lost acceptance criteria suspend as acceptance_changed, preferring the pin check", () => {
  const changed = check("requirements_unchanged", "wait", "acceptance_changed");
  const missing = check("acceptance_present", "wait", "acceptance_missing");
  const expected: RecheckDecision = {
    action: "suspend",
    reason: "acceptance_changed",
  };
  assertEquals(decideRecheck(current(), report([missing, changed])), expected);
  assertEquals(decideRecheck(current(), report([changed])), expected);
  assertEquals(
    decideRecheck(current(), report([missing], { pinChecked: false })),
    expected,
    "without a pin check the missing section still reads as a change",
  );
  assertEquals(
    suspensionReason(
      report([missing, check("not_held", "wait", "held"), changed]),
    ),
    "acceptance_changed",
  );
});

Deno.test("issue 82 unit state: reasons that only exist before a request never suspend one", () => {
  assertEquals(
    decideRecheck(
      current(),
      report([
        check("intent_authorized", "wait", "adoption_required"),
        check("no_active_admission", "wait", "active_request"),
      ]),
    ),
    { action: "none" },
  );
  assertEquals(
    decideRecheck(
      current(),
      report([
        check("intent_authorized", "wait", "adoption_required"),
        check("authority_live", "wait", "no_delegation"),
      ]),
    ),
    { action: "suspend", reason: "no_delegation" },
    "they are skipped, not final",
  );
});

Deno.test("issue 82 unit state: a suspended request resumes only for auto-resumable reasons, to its prior state", () => {
  const cases: [string, Partial<RecheckCurrent>, TicketResumeTarget][] = [
    ["no run", {}, "waiting"],
    ["queued run", { hasRun: true, runStatus: "queued" }, "admitted"],
    ["run waiting for capacity", {
      hasRun: true,
      runStatus: "waiting_capacity",
    }, "admitted"],
    ["run status unknown", { hasRun: true, runStatus: null }, "admitted"],
    ["running run", { hasRun: true, runStatus: "running" }, "active"],
    ["paused run", { hasRun: true, runStatus: "paused" }, "active"],
    [
      "run waiting for input",
      { hasRun: true, runStatus: "waiting_input" },
      "active",
    ],
  ];
  for (const reason of TICKET_AUTO_RESUMABLE_REASONS) {
    for (const [name, change, to] of cases) {
      assertEquals(
        decideRecheck(
          current({
            disposition: "suspended",
            dispositionReason: reason,
            ...change,
          }),
          READY,
        ),
        { action: "resume", to },
        `${reason}, ${name}`,
      );
    }
  }
});

Deno.test("issue 82 unit state: explicit-resume reasons never resume on a recheck", () => {
  for (const reason of TICKET_EXPLICIT_RESUME_REASONS) {
    assertEquals(
      decideRecheck(
        current({ disposition: "suspended", dispositionReason: reason }),
        READY,
      ),
      { action: "none" },
      reason,
    );
  }
  for (const reason of [null, "made_up", "ok", "adoption_required"]) {
    assertEquals(
      decideRecheck(
        current({ disposition: "suspended", dispositionReason: reason }),
        READY,
      ),
      { action: "none" },
      `unknown reason ${reason}`,
    );
  }
  assertEquals(
    decideRecheck(
      current({ disposition: "suspended", dispositionReason: "held" }),
      report([PASS("source_live")], { pinChecked: false }),
    ),
    { action: "none" },
    "a report that did not check the pin cannot resume a pinned request",
  );
  assertEquals(
    decideRecheck(
      current({ disposition: "suspended", dispositionReason: "held" }),
      report([PASS("source_live"), check("not_held", "wait", "held")]),
    ),
    { action: "none" },
    "still held, nothing changes",
  );
});

Deno.test("issue 82 unit state: a stored reason is replaced by a newer one unless it is explicit-resume", () => {
  const suspended = (reason: string | null) =>
    current({ disposition: "suspended", dispositionReason: reason });
  const now = (reason: TicketReasonCode, id: TicketCheckId = "not_held") =>
    report([check(id, "wait", reason)]);
  assertEquals(
    decideRecheck(
      suspended("held"),
      now("predecessor_open", "dependencies_satisfied"),
    ),
    { action: "suspend", reason: "predecessor_open" },
    "auto to auto",
  );
  assertEquals(
    decideRecheck(suspended("held"), now("ticket_closed", "ticket_supported")),
    { action: "suspend", reason: "ticket_closed" },
    "auto escalates to explicit",
  );
  assertEquals(
    decideRecheck(suspended(null), now("held")),
    { action: "suspend", reason: "held" },
    "no stored reason",
  );
  assertEquals(
    decideRecheck(suspended("ticket_closed"), now("held")),
    { action: "none" },
    "explicit stays explicit when only a hold remains",
  );
  assertEquals(
    decideRecheck(
      suspended("ticket_closed"),
      now("has_sub_issues", "epic_excluded"),
    ),
    { action: "none" },
    "the first explicit reason sticks",
  );
  assertEquals(
    decideRecheck(suspended("acceptance_changed"), now("held")),
    { action: "none" },
  );
});

Deno.test("issue 82 unit state: a suspended request that owns a run is paused once", () => {
  const stillHeld = report([check("not_held", "wait", "held")]);
  const withRun = (change: Partial<RecheckCurrent> = {}) =>
    current({
      disposition: "suspended",
      dispositionReason: "held",
      hasRun: true,
      runStatus: "running",
      ...change,
    });
  assertEquals(decideRecheck(withRun(), stillHeld), { action: "pause" });
  assertEquals(
    decideRecheck(
      withRun({ pauseRequestedAt: "2026-11-01T00:00:00Z" }),
      stillHeld,
    ),
    { action: "none" },
    "already requested",
  );
  assertEquals(
    decideRecheck(withRun({ hasRun: false, runStatus: null }), stillHeld),
    { action: "none" },
    "no run to pause",
  );
  assertEquals(
    decideRecheck(
      withRun({ dispositionReason: "ticket_closed" }),
      READY,
    ),
    { action: "pause" },
    "explicit suspension stays suspended, so its run is paused even when ready",
  );
  assertEquals(
    decideRecheck(withRun(), READY),
    { action: "resume", to: "active" },
    "a resumable request is resumed, not paused",
  );
  assertEquals(
    decideRecheck(withRun({ runStatus: "completed" }), stillHeld),
    { action: "terminal", disposition: "completed", reason: "run_completed" },
    "a finished run is not paused",
  );
  assertEquals(
    decideRecheck(
      withRun({ dispositionReason: "ticket_closed" }),
      report([check("not_held", "wait", "held")]),
    ),
    { action: "pause" },
    "a milder reason leaves the explicit one and the pause due",
  );
});

Deno.test("issue 82 unit state: a finished run or task ends the request", () => {
  const finished = ["completed", "failed", "canceled"] as const;
  for (const status of finished) {
    for (const disposition of NONTERMINAL_TICKET_DISPOSITIONS) {
      assertEquals(
        decideRecheck(
          current({
            disposition,
            hasRun: true,
            runStatus: status,
            taskStatus: "active",
          }),
          disposition === "suspended"
            ? READY
            : report([check("not_held", "wait", "held")]),
        ),
        { action: "terminal", disposition: status, reason: `run_${status}` },
        `run ${status} while ${disposition}`,
      );
    }
    assertEquals(
      decideRecheck(current({ taskStatus: status }), READY),
      { action: "terminal", disposition: status, reason: `task_${status}` },
      `task ${status} without a run`,
    );
  }
  assertEquals(
    decideRecheck(
      current({ hasRun: true, runStatus: "failed", taskStatus: "completed" }),
      READY,
    ),
    { action: "terminal", disposition: "failed", reason: "run_failed" },
    "the run outranks the task",
  );
  assertEquals(
    decideRecheck(
      current({ hasRun: true, runStatus: "running", taskStatus: "canceled" }),
      READY,
    ),
    { action: "terminal", disposition: "canceled", reason: "task_canceled" },
    "a live run under a finished task follows the task",
  );
  for (const status of ["paused", "blocked", "waiting_input", "canceling"]) {
    assertEquals(
      decideRecheck(
        current({ hasRun: true, runStatus: status, taskStatus: "active" }),
        READY,
      ),
      { action: "none" },
      `${status} is not terminal`,
    );
  }
  assertEquals(
    decideRecheck(current({ hasRun: false, runStatus: "completed" }), READY),
    { action: "none" },
    "a run status without a run is ignored",
  );
});

Deno.test("issue 82 unit state: a request that is already terminal or pending is never touched", () => {
  const checks = [
    READY,
    report([check("not_held", "wait", "held")]),
  ];
  for (
    const disposition of [...TERMINAL_TICKET_DISPOSITIONS, "pending"] as const
  ) {
    for (const entry of checks) {
      assertEquals(
        decideRecheck(
          current({
            disposition,
            hasRun: true,
            runStatus: "completed",
            taskStatus: "completed",
          }),
          entry,
        ),
        { action: "none" },
        disposition,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Every reason a check can emit has a defined decision.

Deno.test("issue 82 unit state: every suspension reason has exactly one resumable decision", () => {
  const suspending = [
    ...TICKET_AUTO_RESUMABLE_REASONS,
    ...TICKET_EXPLICIT_RESUME_REASONS,
  ];
  assertEquals(
    [...suspending, ...TICKET_NON_SUSPENDING_REASONS].sort(),
    [...TICKET_REASON_CODES].sort(),
    "suspending and non-suspending reasons cover the contract",
  );
  for (const reason of suspending) {
    const auto = TICKET_AUTO_RESUMABLE_REASONS.some((code) => code === reason);
    const explicit = TICKET_EXPLICIT_RESUME_REASONS.some((code) =>
      code === reason
    );
    assertEquals(
      auto !== explicit,
      true,
      `${reason} is in exactly one resume set`,
    );
    assertEquals(
      decideRecheck(
        current({ disposition: "suspended", dispositionReason: reason }),
        READY,
      ),
      auto ? { action: "resume", to: "waiting" } : { action: "none" },
      reason,
    );
  }
});

Deno.test("issue 82 unit state: every (check, reason) pair a check can emit maps to a defined decision", () => {
  let pairs = 0;
  for (const id of TICKET_CHECK_IDS) {
    for (const reason of TICKET_CHECK_REASONS[id]) {
      pairs += 1;
      const status = TICKET_EXPLICIT_RESUME_REASONS.some((code) =>
          code === reason
        ) &&
          reason !== "acceptance_changed"
        ? "reject"
        : "wait";
      const only = report([check(id, status, reason)], { pinChecked: false });
      const decision = decideRecheck(
        current({ disposition: "admitted" }),
        only,
      );
      const nonSuspending = TICKET_NON_SUSPENDING_REASONS.some((code) =>
        code === reason
      );
      if (reason === "acceptance_missing") {
        assertEquals(decision, {
          action: "suspend",
          reason: "acceptance_changed",
        }, `${id}/${reason}`);
      } else if (nonSuspending) {
        assertEquals(decision, { action: "none" }, `${id}/${reason}`);
      } else {
        assertEquals(
          decision,
          { action: "suspend", reason },
          `${id}/${reason}`,
        );
      }
      const reasonOut = suspensionReason(only);
      assert(
        reasonOut === null ||
          TICKET_AUTO_RESUMABLE_REASONS.some((code) => code === reasonOut) ||
          TICKET_EXPLICIT_RESUME_REASONS.some((code) => code === reasonOut),
        `${id}/${reason} suspends on a reason with a resume rule`,
      );
    }
  }
  assertEquals(
    pairs,
    Object.values(TICKET_CHECK_REASONS).reduce(
      (total, reasons) => total + reasons.length,
      0,
    ),
    "every listed pair was walked",
  );
});

// ---------------------------------------------------------------------------
// Property run

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

Deno.test("issue 82 unit state: property run over random check vectors (seed 82) holds the decision invariants", () => {
  const random = mulberry32(82);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  const chance = (probability: number) => random() < probability;
  const decisions = new Set<string>();
  for (let round = 0; round < 3000; round++) {
    const checks: TicketReadinessCheck[] = [];
    const clean = chance(0.3);
    for (const id of TICKET_CHECK_IDS) {
      if (chance(0.2)) continue;
      if (clean || chance(0.85)) {
        checks.push(PASS(id));
      } else {
        checks.push(
          check(
            id,
            chance(0.3) ? "reject" : "wait",
            pick(TICKET_CHECK_REASONS[id]),
          ),
        );
      }
    }
    if (checks.length === 0) checks.push(PASS("source_live"));
    const entry = { verdict: ticketVerdictFromChecks(checks), checks };
    const hasRun = chance(0.5);
    const subject = current({
      disposition: pick(TICKET_REQUEST_DISPOSITIONS),
      dispositionReason: chance(0.1) ? null : pick(TICKET_REASON_CODES),
      intent: pick(["plan", "start"] as const),
      hasRun,
      runStatus: hasRun
        ? pick([
          "queued",
          "running",
          "paused",
          "waiting_capacity",
          "completed",
          "failed",
          "canceled",
        ])
        : null,
      taskStatus: pick([
        "draft",
        "queued",
        "active",
        "blocked",
        "completed",
        "failed",
        "canceled",
      ]),
      approvalAvailable: chance(0.5),
      pinnedRequirementsDigest: chance(0.7) ? PIN : null,
      pauseRequestedAt: chance(0.4) ? "2026-11-01T00:00:00Z" : null,
    });
    const decision = decideRecheck(subject, entry);
    const label =
      `round ${round}: ${subject.disposition}/${subject.dispositionReason} ${decision.action}`;
    decisions.add(decision.action);

    if (!isNonterminalTicketDisposition(subject.disposition)) {
      assertEquals(decision, { action: "none" }, label);
      continue;
    }
    switch (decision.action) {
      case "none":
        break;
      case "terminal":
        assert(isTerminalTicketDisposition(decision.disposition), label);
        assert(canTransition(subject.disposition, decision.disposition), label);
        break;
      case "suspend":
        assert(entry.verdict !== "ready", `${label}: ready never suspends`);
        assert(
          TICKET_AUTO_RESUMABLE_REASONS.some((code) =>
            code === decision.reason
          ) ||
            TICKET_EXPLICIT_RESUME_REASONS.some((code) =>
              code === decision.reason
            ),
          `${label}: suspends on a suspending reason`,
        );
        if (subject.disposition === "suspended") {
          assert(decision.reason !== subject.dispositionReason, label);
          assertEquals(
            TICKET_EXPLICIT_RESUME_REASONS.some((code) =>
              code === subject.dispositionReason
            ),
            false,
            `${label}: an explicit reason is never replaced`,
          );
        } else {
          assert(canTransition(subject.disposition, "suspended"), label);
        }
        break;
      case "pause":
        assertEquals(subject.disposition, "suspended", label);
        assertEquals(subject.hasRun, true, label);
        assertEquals(subject.pauseRequestedAt, null, label);
        break;
      case "resume":
        assertEquals(subject.disposition, "suspended", label);
        assertEquals(entry.verdict, "ready", label);
        assert(
          TICKET_AUTO_RESUMABLE_REASONS.some((code) =>
            code === subject.dispositionReason
          ),
          `${label}: only auto-resumable reasons resume`,
        );
        assert(canTransition("suspended", decision.to), label);
        break;
      case "advance":
        assertEquals(entry.verdict, "ready", label);
        assertEquals(subject.disposition, "waiting", label);
        assertEquals(subject.intent, "start", label);
        assertEquals(subject.approvalAvailable, true, label);
        break;
    }
    if (
      subject.disposition === "suspended" &&
      TICKET_EXPLICIT_RESUME_REASONS.some((code) =>
        code === subject.dispositionReason
      )
    ) {
      assert(decision.action !== "resume", `${label}: explicit never resumes`);
    }
  }
  assertEquals(
    [...decisions].sort(),
    ["advance", "none", "pause", "resume", "suspend", "terminal"],
    "the seed exercises every decision",
  );
});
