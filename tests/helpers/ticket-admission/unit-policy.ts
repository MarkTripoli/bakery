import { assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { defaultTicketSourcePolicy } from "../../../packages/contracts/src/ticket-admission.ts";
import {
  automaticAdmissionAllowed,
  intentFromLabels,
  labelsCoverIntent,
  parseOffsetInstant,
  parseTicketSourcePolicy,
  requestedIntentFromLabels,
} from "../../../apps/server/src/modules/work/ticket-policy.ts";

/**
 * Issue 82 unit lane: the pure policy rules. Parsing is strict, the hold label
 * wins, the execute label covers planning, label names match exactly, and an
 * automatic admission needs a label applied at or after `since`.
 */

const SINCE = "2026-11-01T00:00:00.000Z";

function policyDocument(): Record<string, unknown> {
  return structuredClone(defaultTicketSourcePolicy()) as Record<
    string,
    unknown
  >;
}

function withDelegation(githubActorIds: unknown): Record<string, unknown> {
  return {
    ...policyDocument(),
    delegation: { principalId: crypto.randomUUID(), githubActorIds },
  };
}

function refused(value: unknown): void {
  const error = assertThrows(() => parseTicketSourcePolicy(value));
  if (!(error instanceof StandardError)) {
    throw new Error("a refused policy raises a StandardError");
  }
  assertEquals(error.code, "UNPROCESSABLE");
}

Deno.test("issue 82 unit policy: the default and a delegated policy parse to the stored shape", () => {
  const parsed = parseTicketSourcePolicy(policyDocument());
  assertEquals(parsed, defaultTicketSourcePolicy());
  assertEquals(parsed.approval.plan, "human_approval");
  const principalId = crypto.randomUUID();
  const delegated = parseTicketSourcePolicy({
    ...policyDocument(),
    delegation: { principalId, githubActorIds: ["1001", "1002"] },
    automatic: { enabled: true, since: SINCE },
  });
  assertEquals(delegated.delegation, {
    principalId,
    githubActorIds: ["1001", "1002"],
  });
  assertEquals(delegated.automatic, { enabled: true, since: SINCE });
});

Deno.test("issue 82 unit policy: unknown keys are refused at every level", () => {
  const defaults = defaultTicketSourcePolicy();
  refused({ ...policyDocument(), extra: true });
  refused({ ...policyDocument(), labels: { ...defaults.labels, extra: "x" } });
  refused({
    ...policyDocument(),
    automatic: { enabled: false, since: null, x: 1 },
  });
  refused({
    ...policyDocument(),
    readiness: { requireAcceptanceCriteria: true, x: 1 },
  });
  refused({ ...policyDocument(), approval: { plan: "automatic", x: 1 } });
  refused({
    ...policyDocument(),
    delegation: {
      principalId: crypto.randomUUID(),
      githubActorIds: ["1"],
      x: 1,
    },
  });
  refused({ ...policyDocument(), preset: "other-preset" });
  refused({ ...policyDocument(), version: 2 });
});

Deno.test("issue 82 unit policy: delegation holds 1 to 25 unique numeric GitHub ids", () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => String(5000 + index));
  parseTicketSourcePolicy(withDelegation(ids(1)));
  parseTicketSourcePolicy(withDelegation(ids(25)));
  refused(withDelegation(ids(26)));
  refused(withDelegation([]));
  refused(withDelegation(["octocat"]));
  refused(withDelegation(["12a"]));
  refused(withDelegation(["012"]));
  refused(withDelegation([12]));
  refused(withDelegation(["12", "12"]));
  refused({
    ...policyDocument(),
    delegation: { principalId: "not-a-uuid", githubActorIds: ["1"] },
  });
});

Deno.test("issue 82 unit policy: label names carry no expression, URL or control character", () => {
  const defaults = defaultTicketSourcePolicy();
  const withExecute = (execute: string) => ({
    ...policyDocument(),
    labels: { ...defaults.labels, execute },
  });
  parseTicketSourcePolicy(withExecute("ready \u{1F680}"));
  refused(withExecute("${{ secrets.TOKEN }}"));
  refused(withExecute("{{ run }}"));
  refused(withExecute("https://example.test/hook"));
  refused(withExecute("run`id`"));
  refused(withExecute("line\nbreak"));
  refused(withExecute(" padded"));
  refused(withExecute(""));
  refused(withExecute("x".repeat(51)));
  refused(withExecute(defaults.labels.hold));
  refused({
    ...policyDocument(),
    labels: { ...defaults.labels, planOnly: defaults.labels.execute },
  });
});

Deno.test("issue 82 unit policy: automatic admission needs a since, and a non-object is refused", () => {
  refused({ ...policyDocument(), automatic: { enabled: true, since: null } });
  refused({ ...policyDocument(), automatic: { enabled: true } });
  refused({ ...policyDocument(), automatic: { enabled: true, since: "soon" } });
  parseTicketSourcePolicy({
    ...policyDocument(),
    automatic: { enabled: true, since: SINCE },
  });
  parseTicketSourcePolicy({
    ...policyDocument(),
    automatic: { enabled: false, since: null },
  });
  refused(null);
  refused("policy");
  refused([]);
});

const POLICY = defaultTicketSourcePolicy();
const EXECUTE = POLICY.labels.execute;
const PLAN_ONLY = "ready for planning";
const HOLD = POLICY.labels.hold;

Deno.test("issue 82 unit policy: the label intent matrix", () => {
  const cases: [string, string[], { intent: string | null; hold: boolean }][] =
    [
      ["no labels", [], { intent: null, hold: false }],
      ["unrelated labels", ["bug", "good first issue"], {
        intent: null,
        hold: false,
      }],
      ["execute label", [EXECUTE], { intent: "start", hold: false }],
      ["planning-only label", [PLAN_ONLY], { intent: "plan", hold: false }],
      ["execute covers planning", [PLAN_ONLY, EXECUTE], {
        intent: "start",
        hold: false,
      }],
      ["execute beside others", ["bug", EXECUTE, "p1"], {
        intent: "start",
        hold: false,
      }],
      ["hold alone", [HOLD], { intent: null, hold: true }],
      ["hold beats execute", [EXECUTE, HOLD], { intent: null, hold: true }],
      ["hold beats planning-only", [HOLD, PLAN_ONLY], {
        intent: null,
        hold: true,
      }],
      ["hold beats both", [PLAN_ONLY, EXECUTE, HOLD], {
        intent: null,
        hold: true,
      }],
    ];
  for (const [name, labels, expected] of cases) {
    assertEquals(intentFromLabels(labels, POLICY), expected, name);
  }
});

Deno.test("issue 82 unit policy: label names match exactly and case-sensitively", () => {
  for (
    const near of [
      "Ready for agent",
      "ready for agent ",
      " ready for agent",
      "ready  for agent",
      "ready-for-agent",
      "READY FOR AGENT",
    ]
  ) {
    assertEquals(
      intentFromLabels([near], POLICY),
      { intent: null, hold: false },
      near,
    );
  }
  assertEquals(
    intentFromLabels(["Bakery:Hold"], POLICY),
    { intent: null, hold: false },
  );
});

Deno.test("issue 82 unit policy: a renamed label is read by its new name only", () => {
  const renamed = parseTicketSourcePolicy({
    ...policyDocument(),
    labels: { execute: "go bakery", planOnly: null, hold: "stop bakery" },
  });
  assertEquals(intentFromLabels([EXECUTE], renamed), {
    intent: null,
    hold: false,
  });
  assertEquals(intentFromLabels(["go bakery"], renamed), {
    intent: "start",
    hold: false,
  });
  assertEquals(intentFromLabels(["go bakery", "stop bakery"], renamed), {
    intent: null,
    hold: true,
  });
  assertEquals(
    intentFromLabels([PLAN_ONLY], renamed),
    { intent: null, hold: false },
    "with the planning label disabled its old name asks for nothing",
  );
});

Deno.test("issue 82 unit policy: label coverage ignores hold and execute covers both intents", () => {
  assertEquals(labelsCoverIntent([EXECUTE], POLICY, "start"), true);
  assertEquals(labelsCoverIntent([EXECUTE], POLICY, "plan"), true);
  assertEquals(labelsCoverIntent([PLAN_ONLY], POLICY, "plan"), true);
  assertEquals(labelsCoverIntent([PLAN_ONLY], POLICY, "start"), false);
  assertEquals(labelsCoverIntent([], POLICY, "plan"), false);
  assertEquals(labelsCoverIntent(["bug"], POLICY, "start"), false);
  assertEquals(
    labelsCoverIntent([EXECUTE, HOLD], POLICY, "start"),
    true,
    "hold is its own check",
  );
  assertEquals(requestedIntentFromLabels([EXECUTE, HOLD], POLICY), "start");
});

Deno.test("issue 82 unit policy: automatic admission needs enabled, a since, and a label at or after it", () => {
  const enabled = parseTicketSourcePolicy({
    ...policyDocument(),
    automatic: { enabled: true, since: SINCE },
  });
  assertEquals(
    automaticAdmissionAllowed(enabled, "2026-11-01T00:00:00.000Z"),
    true,
  );
  assertEquals(
    automaticAdmissionAllowed(enabled, "2026-11-01T00:00:00.001Z"),
    true,
  );
  assertEquals(
    automaticAdmissionAllowed(enabled, "2027-01-01T00:00:00Z"),
    true,
  );
  assertEquals(
    automaticAdmissionAllowed(enabled, "2026-10-31T23:59:59.999Z"),
    false,
  );
  assertEquals(
    automaticAdmissionAllowed(enabled, "2026-11-01T01:00:00+01:00"),
    true,
    "an offset timestamp is compared by instant, here equal to since",
  );
  assertEquals(
    automaticAdmissionAllowed(enabled, "2026-11-01T00:30:00+01:00"),
    false,
    "00:30 at +01:00 is before 00:00Z",
  );
  assertEquals(automaticAdmissionAllowed(enabled, "not a timestamp"), false);
  assertEquals(automaticAdmissionAllowed(enabled, ""), false);

  assertEquals(
    automaticAdmissionAllowed(
      defaultTicketSourcePolicy(),
      "2030-01-01T00:00:00Z",
    ),
    false,
    "disabled",
  );
  // A hand-built policy that bypasses the stored schema still fails closed.
  assertEquals(
    automaticAdmissionAllowed(
      { automatic: { enabled: true, since: null } },
      "2030-01-01T00:00:00Z",
    ),
    false,
    "enabled without a since",
  );
  assertEquals(
    automaticAdmissionAllowed(
      { automatic: { enabled: false, since: SINCE } },
      "2030-01-01T00:00:00Z",
    ),
    false,
    "a since beside a disabled switch",
  );
});

Deno.test("issue 82 unit policy: a label time without an explicit offset never admits, whatever the process time zone", () => {
  const enabled = parseTicketSourcePolicy({
    ...policyDocument(),
    delegation: { principalId: crypto.randomUUID(), githubActorIds: ["1001"] },
    automatic: { enabled: true, since: SINCE },
  });
  // Each of these would parse (as local time, or as a rolled-over date) with
  // `Date.parse`, and several land after `since` in a western or a UTC zone.
  for (
    const appliedAt of [
      "2026-11-01T00:00:00",
      "2026-11-01T00:00:01",
      "2026-10-31T21:00:00",
      "2027-01-01T00:00:00",
      "2026-11-02",
      "2026-11-01T00:00:01+0100",
      "2026-11-01T00:00:01+01",
      "2026-11-01T00:00:01z",
      "2026-11-01 00:00:01Z",
      "2026-02-30T00:00:00Z",
      "2026-11-01T24:00:00Z",
      "2026-11-01T00:60:00Z",
      "2026-11-01T00:00:60Z",
      "2026-11-01T00:00:01+24:00",
      "2026-11-01T00:00:01+01:60",
      `2026-11-01T00:00:01.${"1".repeat(10)}Z`,
      " 2026-11-01T00:00:01Z",
      "2026-11-01T00:00:01Z ",
    ]
  ) {
    assertEquals(
      automaticAdmissionAllowed(enabled, appliedAt),
      false,
      appliedAt,
    );
    assertEquals(parseOffsetInstant(appliedAt), null, appliedAt);
  }
  // An unqualified `since` fails closed too, even beside a valid label time.
  assertEquals(
    automaticAdmissionAllowed(
      { automatic: { enabled: true, since: "2026-11-01T00:00:00" } },
      "2030-01-01T00:00:00Z",
    ),
    false,
    "since without an offset",
  );
});

Deno.test("issue 82 unit policy: offset timestamps are compared by instant down to the nanosecond", () => {
  const enabled = parseTicketSourcePolicy({
    ...policyDocument(),
    delegation: { principalId: crypto.randomUUID(), githubActorIds: ["1001"] },
    automatic: { enabled: true, since: SINCE },
  });
  const cases: [string, boolean][] = [
    ["2026-10-31T19:00:00-05:00", true],
    ["2026-10-31T18:59:59-05:00", false],
    ["2026-11-01T05:30:00+05:30", true],
    ["2026-11-01T05:29:59+05:30", false],
    ["2026-11-01T00:00:00Z", true],
    ["2026-11-01T00:00:00.000000001Z", true],
    ["2026-10-31T23:59:59.999999999Z", false],
    ["2028-02-29T12:00:00Z", true],
    ["2026-10-31T23:59:59-00:00", false],
    ["2026-11-01T00:00:00-00:00", true],
  ];
  for (const [appliedAt, allowed] of cases) {
    assertEquals(
      automaticAdmissionAllowed(enabled, appliedAt),
      allowed,
      appliedAt,
    );
  }
  assertEquals(
    parseOffsetInstant("2026-11-01T00:00:00Z"),
    parseOffsetInstant("2026-10-31T19:00:00-05:00"),
  );
  assertEquals(
    parseOffsetInstant("1970-01-01T00:00:00Z"),
    0n,
    "the epoch",
  );
  assertEquals(
    parseOffsetInstant("1970-01-01T00:00:01.5Z"),
    1_500_000_000n,
    "a fraction of a second",
  );
});
