import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { CHECK_KINDS } from "../../../packages/contracts/src/check-evidence.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  assessFreshness,
  type BoundPart,
  boundParts,
  type CandidateIdentity,
  CandidateIdentitySchema,
  type CheckRunEvidence,
  commandSubjectDigest,
  ruleSubjectDigest,
  subjectKey,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  assertCandidateChecksSatisfied,
  type CheckRequirement,
  DELIVERY_CHECKS_BLOCKED_REASON,
  evaluateCandidateChecks,
} from "../../../apps/server/src/modules/delivery/verdict.ts";
import { commitsEntry, titleEntry } from "../repository-rule-entries.ts";
import {
  currentIdentity,
  digest,
  effectiveEntries,
  rowFor,
  SUBJECT_BODY,
  SUBJECT_COMMITS,
  SUBJECT_TITLE,
  SUBJECT_UNIT,
} from "./identity-fixture.ts";
import { registerMetadataCases } from "./metadata-cases.ts";
import { transportType } from "./observations.ts";

/**
 * Freshness, verdict and metadata cases for the check evidence identities.
 * Phase 1 pins the columns the freshness code compares; Phase 2 adds the pure
 * matrix. The issue-named unit test registers all of it through this module.
 */

/** Identity parts a stale decision can depend on, as `CheckRun` fields. */
export const FRESHNESS_IDENTITY_FIELDS = Object.freeze(
  [
    "headSha",
    "baseSha",
    "profileDigest",
    "policyDigest",
    "subjectDigest",
    "checkerDigest",
    "titleDigest",
    "bodyDigest",
    "mergeMessageDigest",
    "commitSelectionDigest",
  ] as const,
);

/** One change to the candidate and the parts it must stale, per row kind. */
type Change = {
  name: string;
  apply: (current: CandidateIdentity) => CandidateIdentity;
  stale: Partial<Record<keyof typeof rowFor, BoundPart[]>>;
};

const changes: Change[] = [
  {
    name: "head only",
    apply: (c) => ({ ...c, headSha: "9".repeat(40) }),
    stale: {
      command: ["head"],
      commits: ["head"],
      title: ["head"],
      description: ["head"],
      mergeMessage: ["head"],
    },
  },
  {
    name: "base only",
    apply: (c) => ({ ...c, baseSha: "8".repeat(40) }),
    stale: {
      command: ["base"],
      commits: ["base"],
      title: ["base"],
      description: ["base"],
      mergeMessage: ["base"],
    },
  },
  {
    name: "profile only",
    apply: (c) => ({ ...c, profileDigest: digest(100) }),
    stale: { command: ["profile"] },
  },
  {
    name: "fixed-command digest only",
    apply: (c) => ({
      ...c,
      subjects: { ...c.subjects, [SUBJECT_UNIT]: digest(101) },
    }),
    stale: { command: ["subject"] },
  },
  {
    name: "checker only",
    apply: (c) => ({ ...c, checkerDigest: digest(102) }),
    stale: { command: ["checker"] },
  },
  {
    name: "title only",
    apply: (c) => ({ ...c, titleDigest: digest(103) }),
    stale: { title: ["title"] },
  },
  {
    name: "body only",
    apply: (c) => ({ ...c, bodyDigest: digest(104) }),
    stale: { description: ["body"] },
  },
  {
    name: "message only",
    apply: (c) => ({ ...c, mergeMessageDigest: digest(105) }),
    stale: { mergeMessage: ["merge_message"] },
  },
  {
    name: "commit selection only",
    apply: (c) => ({ ...c, commitSelectionDigest: digest(106) }),
    stale: { commits: ["commit_selection"] },
  },
  {
    name: "rule entry only (the title rule)",
    apply: (c) => ({
      ...c,
      subjects: { ...c.subjects, [SUBJECT_TITLE]: digest(107) },
    }),
    stale: { title: ["subject"] },
  },
  {
    name: "rule entry only (the description rule)",
    apply: (c) => ({
      ...c,
      subjects: { ...c.subjects, [SUBJECT_BODY]: digest(108) },
    }),
    stale: { description: ["subject"] },
  },
  {
    name: "rule entry only (the commits rule)",
    apply: (c) => ({
      ...c,
      subjects: { ...c.subjects, [SUBJECT_COMMITS]: digest(109) },
    }),
    stale: { commits: ["subject"], mergeMessage: ["subject"] },
  },
  {
    name: "unrelated rule and command only",
    apply: (c) => ({
      ...c,
      subjects: { ...c.subjects, "command:lint": digest(110) },
    }),
    stale: {},
  },
];

const kinds = Object.keys(rowFor) as Array<keyof typeof rowFor>;

function registerMatrix(): void {
  for (const change of changes) {
    Deno.test(`freshness matrix: ${change.name} stales exactly the rows bound to it`, () => {
      const changed = change.apply(currentIdentity());
      for (const kind of kinds) {
        const assessment = assessFreshness(rowFor[kind](), changed);
        const expected = change.stale[kind];
        if (expected === undefined) {
          assertEquals(
            assessment,
            { fresh: true },
            `a ${kind} row must stay fresh on ${change.name}`,
          );
        } else {
          assertEquals(
            assessment,
            { fresh: false, changed: expected },
            `a ${kind} row must go stale on ${change.name}`,
          );
        }
      }
    });
  }

  Deno.test("an unchanged candidate leaves every row fresh", () => {
    for (const kind of kinds) {
      assertEquals(assessFreshness(rowFor[kind](), currentIdentity()), {
        fresh: true,
      });
    }
  });

  Deno.test("a title change stales the title row and leaves every other kind fresh", () => {
    const titleChanged = currentIdentity({ titleDigest: digest(120) });
    assertFalse(assessFreshness(rowFor.title(), titleChanged).fresh);
    for (
      const kind of [
        "command",
        "commits",
        "description",
        "mergeMessage",
      ] as const
    ) {
      assert(assessFreshness(rowFor[kind](), titleChanged).fresh, kind);
    }
  });

  Deno.test("a part the current identity cannot supply counts as changed", () => {
    const missing: Array<[string, CandidateIdentity, CheckRunEvidence]> = [
      ["base", currentIdentity({ baseSha: null }), rowFor.command()],
      ["profile", currentIdentity({ profileDigest: null }), rowFor.command()],
      ["checker", currentIdentity({ checkerDigest: null }), rowFor.command()],
      ["title", currentIdentity({ titleDigest: null }), rowFor.title()],
      ["body", currentIdentity({ bodyDigest: null }), rowFor.description()],
      [
        "merge_message",
        currentIdentity({ mergeMessageDigest: null }),
        rowFor.mergeMessage(),
      ],
      [
        "commit_selection",
        currentIdentity({ commitSelectionDigest: null }),
        rowFor.commits(),
      ],
      [
        "subject",
        currentIdentity({ subjects: {} }),
        rowFor.command(),
      ],
    ];
    for (const [part, current, row] of missing) {
      assertEquals(
        assessFreshness(row, current),
        { fresh: false, changed: [part as BoundPart] },
        part,
      );
    }
  });

  Deno.test("a part the row never recorded counts as changed even against a null current", () => {
    const row = rowFor.title({ titleDigest: null });
    assertEquals(assessFreshness(row, currentIdentity()), {
      fresh: false,
      changed: ["title"],
    });
    assertEquals(
      assessFreshness(row, currentIdentity({ titleDigest: null })),
      { fresh: false, changed: ["title"] },
    );
  });

  Deno.test("subject keys never confuse a command with a rule of the same name", () => {
    assertNotEquals(
      subjectKey("command", "commits.semantic"),
      subjectKey("commits", "commits.semantic"),
    );
    const current = currentIdentity({
      subjects: { [subjectKey("command", "commits.semantic")]: digest(300) },
    });
    // The rule row needs the rule's subject, which is absent here.
    assertEquals(assessFreshness(rowFor.commits(), current), {
      fresh: false,
      changed: ["subject"],
    });
    assert(Object.hasOwn(current.subjects, "command:commits.semantic"));
    const inherited = currentIdentity({ subjects: {} });
    assertFalse(
      assessFreshness(rowFor.command({ checkId: "constructor" }), inherited)
        .fresh,
      "an inherited property must not read as a subject digest",
    );
  });

  Deno.test("every kind has bound parts, each listed once, and the head, base and subject are always bound", () => {
    for (const kind of CHECK_KINDS) {
      const parts = boundParts(kind);
      assert(parts.length > 0, kind);
      assertEquals(new Set(parts).size, parts.length, kind);
      for (const part of ["head", "base", "subject"] as const) {
        assert(parts.includes(part), `${kind} is not bound to ${part}`);
      }
    }
    assertEquals([...boundParts("command")], [
      "head",
      "base",
      "profile",
      "checker",
      "subject",
    ]);
    assertEquals([...boundParts("commits")], [
      "head",
      "base",
      "commit_selection",
      "subject",
    ]);
    assertEquals([...boundParts("title")], [
      "head",
      "base",
      "title",
      "subject",
    ]);
    assertEquals([...boundParts("description")], [
      "head",
      "base",
      "body",
      "subject",
    ]);
    assertEquals([...boundParts("merge_message")], [
      "head",
      "base",
      "merge_message",
      "subject",
    ]);
  });

  Deno.test("an organization revision bump over equal entries leaves rule rows fresh", async () => {
    const rules = [commitsEntry(false), titleEntry()];
    const before = await effectiveEntries(rules, 3);
    const after = await effectiveEntries(rules, 4);
    assertNotEquals(
      before[0].organizationRevision,
      after[0].organizationRevision,
    );
    const recorded = await ruleSubjectDigest(before[1]);
    const row = rowFor.title({ subjectDigest: recorded });
    const bumped = currentIdentity({
      subjects: { [SUBJECT_TITLE]: await ruleSubjectDigest(after[1]) },
    });
    assertEquals(assessFreshness(row, bumped), { fresh: true });
    // A real change to the entry still stales it.
    const [changedEntry] = await effectiveEntries([titleEntry(50)], 4);
    const edited = currentIdentity({
      subjects: { [SUBJECT_TITLE]: await ruleSubjectDigest(changedEntry) },
    });
    assertEquals(assessFreshness(row, edited), {
      fresh: false,
      changed: ["subject"],
    });
  });

  Deno.test("a command subject tracks its argv and its bound rule, and nothing else", async () => {
    const [rule] = await effectiveEntries([
      {
        ruleKey: "code.magicNumbers",
        enabled: true,
        mode: "require",
        options: {
          checkBinding: "magic",
          allowedNumbers: [0],
          excludedPaths: [],
        },
        locked: false,
      },
    ], 1);
    const [bumped] = await effectiveEntries([
      {
        ruleKey: "code.magicNumbers",
        enabled: true,
        mode: "require",
        options: {
          checkBinding: "magic",
          allowedNumbers: [0],
          excludedPaths: [],
        },
        locked: false,
      },
    ], 2);
    const command = { id: "magic", argv: ["deno", "lint"] };
    const base = await commandSubjectDigest(command, rule);
    assertEquals(base.length, 64);
    assertEquals(await commandSubjectDigest(command, bumped), base);
    assertNotEquals(
      await commandSubjectDigest(
        { ...command, argv: ["deno", "lint", "-q"] },
        rule,
      ),
      base,
    );
    assertNotEquals(await commandSubjectDigest(command, null), base);
    assertNotEquals(
      await commandSubjectDigest({ ...command, id: "other" }, rule),
      base,
    );
  });

  Deno.test("the candidate identity schema carries a description on every node", () => {
    const parsed = CandidateIdentitySchema.parse(currentIdentity());
    assertEquals(parsed.headSha.length, 40);
    for (const bad of ["", "ABC", "g".repeat(40), "1".repeat(41)]) {
      assertFalse(
        CandidateIdentitySchema.safeParse({
          ...currentIdentity(),
          headSha: bad,
        })
          .success,
        bad,
      );
    }
    assertFalse(
      CandidateIdentitySchema.safeParse({
        ...currentIdentity(),
        subjects: { "command:unit": "not-a-digest" },
      }).success,
    );
    assertFalse(
      CandidateIdentitySchema.safeParse({ ...currentIdentity(), extra: 1 })
        .success,
    );
  });
}

const required = (
  kind: CheckRequirement["kind"],
  checkId: string,
  mode: CheckRequirement["mode"] = "require",
): CheckRequirement => ({ kind, checkId, mode });

function registerVerdict(): void {
  Deno.test("no rows means missing means blocked", () => {
    const verdict = evaluateCandidateChecks({
      requirements: [
        required("command", "unit"),
        required("title", "changeRequest.semanticTitle"),
      ],
      rows: [],
      current: currentIdentity(),
    });
    assert(verdict.blocked);
    assertEquals(verdict.evaluations.map(({ status }) => status), [
      "missing",
      "missing",
    ]);
    assertEquals(verdict.evaluations[0].reason, "no_row");
    assertEquals(verdict.blockedChecks.length, 2);
    assertEquals(verdict.reason, null);
  });

  Deno.test("an empty requirement list is a missing policy and blocks, whatever rows exist", () => {
    const rows = [rowFor.command(), rowFor.title(), rowFor.description()];
    const verdict = evaluateCandidateChecks({
      requirements: [],
      rows,
      current: currentIdentity(),
    });
    assert(verdict.blocked);
    assertEquals(verdict.reason, "policy_missing");
    assertEquals(verdict.evaluations, []);
    assertEquals(verdict.blockedChecks, []);
    assertEquals(
      evaluateCandidateChecks({
        requirements: [],
        rows: [],
        current: currentIdentity(),
      }).reason,
      "policy_missing",
    );
    const error = assertThrows(
      () => assertCandidateChecksSatisfied(verdict),
      StandardError,
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "delivery_checks_blocked");
    assertEquals(error.params?.blockedReason, "policy_missing");
    assertEquals(error.params?.blockedCheckIds, []);
    // A policy that only warns or guides is a policy: it is not blocked, and
    // it carries no missing-policy reason.
    const advisory = evaluateCandidateChecks({
      requirements: [
        required("command", "unit", "warn"),
        required("title", "changeRequest.semanticTitle", "guide"),
      ],
      rows: [],
      current: currentIdentity(),
    });
    assertFalse(advisory.blocked);
    assertEquals(advisory.reason, null);
    assertCandidateChecksSatisfied(advisory);
  });

  Deno.test("fresh passed rows for every requirement leave the delivery unblocked", () => {
    const verdict = evaluateCandidateChecks({
      requirements: [
        required("command", "unit"),
        required("title", "changeRequest.semanticTitle"),
        required("description", "changeRequest.description"),
        required("commits", "commits.semantic"),
      ],
      rows: [
        rowFor.command(),
        rowFor.title(),
        rowFor.description(),
        rowFor.commits(),
      ],
      current: currentIdentity(),
    });
    assertFalse(verdict.blocked);
    assertEquals(
      verdict.evaluations.map(({ status }) => status),
      ["passed", "passed", "passed", "passed"],
    );
    assertEquals(verdict.blockedChecks, []);
    assertCandidateChecksSatisfied(verdict);
  });

  Deno.test("a required unavailable or skipped check blocks and stays apart from failed", () => {
    for (
      const reason of [
        "tool_missing",
        "unsupported_checker",
        "skipped",
        "metadata_missing",
        "metadata_too_large",
        "rule_unbound",
        "revision_unavailable",
      ] as const
    ) {
      const verdict = evaluateCandidateChecks({
        requirements: [required("command", "unit")],
        rows: [rowFor.command({ result: "unavailable", reason })],
        current: currentIdentity(),
      });
      assert(verdict.blocked, reason);
      assertEquals(verdict.evaluations[0].status, "unavailable", reason);
      assertEquals(verdict.evaluations[0].reason, reason);
    }
    const failed = evaluateCandidateChecks({
      requirements: [required("command", "unit")],
      rows: [rowFor.command({ result: "failed", reason: "exit_nonzero" })],
      current: currentIdentity(),
    });
    assert(failed.blocked);
    assertEquals(failed.evaluations[0].status, "failed");
  });

  Deno.test("require blocks, warn keeps its finding without blocking, guide is not consulted", () => {
    const rows = [
      rowFor.command({ result: "failed", reason: "exit_nonzero" }),
      rowFor.title({ result: "failed", reason: "rule_violation" }),
      rowFor.description({ result: "failed", reason: "rule_violation" }),
    ];
    const current = currentIdentity();
    const warn = evaluateCandidateChecks({
      requirements: [
        required("command", "unit", "warn"),
        required("title", "changeRequest.semanticTitle", "warn"),
        required("description", "changeRequest.description", "guide"),
      ],
      rows,
      current,
    });
    assertFalse(warn.blocked);
    assertEquals(warn.evaluations.map(({ status }) => status), [
      "failed",
      "failed",
      "not_blocking",
    ]);
    assertEquals(warn.evaluations.map(({ blocking }) => blocking), [
      false,
      false,
      false,
    ]);
    assertEquals(warn.evaluations[2].reason, "guide");
    assertEquals(warn.evaluations[2].rowId, null);
    const strict = evaluateCandidateChecks({
      requirements: [
        required("command", "unit", "require"),
        required("title", "changeRequest.semanticTitle", "warn"),
      ],
      rows,
      current,
    });
    assert(strict.blocked);
    assertEquals(
      strict.blockedChecks.map(({ requirement }) => requirement.checkId),
      [
        "unit",
      ],
    );
    // A warn requirement with no row at all is missing, and still does not block.
    const absent = evaluateCandidateChecks({
      requirements: [required("command", "lint", "warn")],
      rows: [],
      current,
    });
    assertFalse(absent.blocked);
    assertEquals(absent.evaluations[0].status, "missing");
  });

  Deno.test("a changed identity makes a passed row stale and blocks", () => {
    const verdict = evaluateCandidateChecks({
      requirements: [required("title", "changeRequest.semanticTitle")],
      rows: [rowFor.title()],
      current: currentIdentity({ titleDigest: digest(200) }),
    });
    assert(verdict.blocked);
    assertEquals(verdict.evaluations[0].status, "stale");
    assertEquals(verdict.evaluations[0].reason, "stale");
    assertEquals(verdict.evaluations[0].changed, ["title"]);
  });

  Deno.test("a row that did not pass keeps its own status when the candidate has changed", () => {
    // Staleness answers "is this pass still true". A row that never passed has
    // no pass to invalidate, so failed and unavailable stay visible, and every
    // one of them keeps blocking.
    const moved = currentIdentity({
      headSha: "9".repeat(40),
      titleDigest: digest(200),
    });
    const outcomes: Array<
      [Partial<CheckRunEvidence>, string, CheckRequirement["mode"]]
    > = [
      [{ result: "failed", reason: "rule_violation" }, "failed", "require"],
      [{ result: "failed", reason: "exit_nonzero" }, "failed", "require"],
      [
        { result: "unavailable", reason: "tool_missing" },
        "unavailable",
        "require",
      ],
      [
        { result: "unavailable", reason: "skipped" },
        "unavailable",
        "require",
      ],
      [{ result: "canceled", reason: "canceled" }, "unavailable", "require"],
      [
        { result: "pending", reason: "awaiting_result" },
        "missing",
        "require",
      ],
      // A warn requirement reports the same status and still does not block.
      [{ result: "failed", reason: "rule_violation" }, "failed", "warn"],
    ];
    for (const [overrides, status, mode] of outcomes) {
      const row = rowFor.title(overrides);
      const verdict = evaluateCandidateChecks({
        requirements: [required("title", "changeRequest.semanticTitle", mode)],
        rows: [row],
        current: moved,
      });
      const label = `${row.result}/${row.reason} (${mode})`;
      assertEquals(verdict.blocked, mode === "require", label);
      assertEquals(verdict.evaluations[0].status, status, label);
      assertEquals(verdict.evaluations[0].reason, row.reason, label);
      assertEquals(verdict.evaluations[0].rowId, row.id, label);
      assertEquals(verdict.evaluations[0].changed, [], label);
    }
  });

  Deno.test("a required unavailable metadata_missing row recorded with null digests reads unavailable, never stale", () => {
    // What an unreadable metadata source records: no digest for any part.
    const unread = (kind: keyof typeof rowFor, overrides = {}) =>
      rowFor[kind]({
        result: "unavailable",
        reason: "metadata_missing",
        baseSha: null,
        titleDigest: null,
        bodyDigest: null,
        mergeMessageDigest: null,
        commitSelectionDigest: null,
        ...overrides,
      });
    const requirements = [
      required("title", "changeRequest.semanticTitle"),
      required("description", "changeRequest.description"),
      required("commits", "commits.semantic"),
    ];
    const rows = [unread("title"), unread("description"), unread("commits")];
    const nothingKnown = currentIdentity({
      titleDigest: null,
      bodyDigest: null,
      mergeMessageDigest: null,
      commitSelectionDigest: null,
    });
    for (const current of [nothingKnown, currentIdentity()]) {
      const verdict = evaluateCandidateChecks({ requirements, rows, current });
      assert(verdict.blocked);
      assertEquals(
        verdict.evaluations.map(({ status, reason }) => [status, reason]),
        [
          ["unavailable", "metadata_missing"],
          ["unavailable", "metadata_missing"],
          ["unavailable", "metadata_missing"],
        ],
      );
      assertEquals(verdict.blockedChecks.length, 3);
    }
    // The error callers see names the true state, not a change in the candidate.
    const error = assertThrows(
      () =>
        assertCandidateChecksSatisfied(
          evaluateCandidateChecks({
            requirements: [requirements[0]],
            rows: [rows[0]],
            current: nothingKnown,
          }),
        ),
      StandardError,
    );
    assertEquals(error.params?.blocked, [{
      kind: "title",
      checkId: "changeRequest.semanticTitle",
      status: "unavailable",
      reason: "metadata_missing",
    }]);
  });

  Deno.test("a passed row that recorded no digest for a bound part is still stale", () => {
    // Only a pass is judged for staleness, and missing information never keeps
    // it fresh: the F1 change must not turn a hollow pass into a pass.
    const hollow = rowFor.title({ titleDigest: null });
    for (
      const current of [
        currentIdentity(),
        currentIdentity({ titleDigest: null }),
      ]
    ) {
      const verdict = evaluateCandidateChecks({
        requirements: [required("title", "changeRequest.semanticTitle")],
        rows: [hollow],
        current,
      });
      assert(verdict.blocked);
      assertEquals(verdict.evaluations[0].status, "stale");
      assertEquals(verdict.evaluations[0].changed, ["title"]);
    }
  });

  Deno.test("the newest row wins and an older pass never masks a newer failure", () => {
    const older = rowFor.command({ createdAt: "2026-10-31T12:00:00.000Z" });
    const newer = rowFor.command({
      createdAt: "2026-10-31T12:00:01.000Z",
      result: "failed",
      reason: "exit_nonzero",
    });
    const requirements = [required("command", "unit")];
    for (const rows of [[older, newer], [newer, older]]) {
      const verdict = evaluateCandidateChecks({
        requirements,
        rows,
        current: currentIdentity(),
      });
      assert(verdict.blocked);
      assertEquals(verdict.evaluations[0].status, "failed");
      assertEquals(verdict.evaluations[0].rowId, newer.id);
    }
    // The other way round: a newer pass supersedes an older failure.
    const recovered = rowFor.command({ createdAt: "2026-10-31T12:00:02.000Z" });
    const verdict = evaluateCandidateChecks({
      requirements,
      rows: [newer, recovered],
      current: currentIdentity(),
    });
    assertFalse(verdict.blocked);
    assertEquals(verdict.evaluations[0].rowId, recovered.id);
  });

  Deno.test("rows recorded at the same instant resolve worst-first, whatever the order", () => {
    const at = "2026-10-31T12:00:00.000Z";
    // The pass has the larger id, so only the ordering rule can pick the failure.
    const pass = rowFor.command({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      createdAt: at,
    });
    const fail = rowFor.command({
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: at,
      result: "failed",
      reason: "exit_nonzero",
    });
    for (const rows of [[pass, fail], [fail, pass]]) {
      const verdict = evaluateCandidateChecks({
        requirements: [required("command", "unit")],
        rows,
        current: currentIdentity(),
      });
      assert(verdict.blocked);
      assertEquals(verdict.evaluations[0].rowId, fail.id);
    }
  });

  Deno.test("rows for other checks, kinds and rules never answer a requirement", () => {
    const verdict = evaluateCandidateChecks({
      requirements: [required("command", "unit")],
      rows: [
        rowFor.command({ checkId: "lint" }),
        rowFor.title({ checkId: "unit" }),
      ],
      current: currentIdentity(),
    });
    assert(verdict.blocked);
    assertEquals(verdict.evaluations[0].status, "missing");
  });

  Deno.test("a pending or canceled row is not a pass and a contradictory row is never one", () => {
    const requirements = [required("command", "unit")];
    const current = currentIdentity();
    const pending = evaluateCandidateChecks({
      requirements,
      rows: [rowFor.command({ result: "pending", reason: "awaiting_result" })],
      current,
    });
    assert(pending.blocked);
    assertEquals(pending.evaluations[0].status, "missing");
    assertEquals(pending.evaluations[0].reason, "awaiting_result");
    const canceled = evaluateCandidateChecks({
      requirements,
      rows: [rowFor.command({ result: "canceled", reason: "canceled" })],
      current,
    });
    assert(canceled.blocked);
    assertEquals(canceled.evaluations[0].status, "unavailable");
    const contradictory = evaluateCandidateChecks({
      requirements,
      rows: [rowFor.command({ result: "passed", reason: "exit_nonzero" })],
      current,
    });
    assert(contradictory.blocked);
    assertEquals(contradictory.evaluations[0].status, "unavailable");
    assertEquals(contradictory.evaluations[0].reason, "row_incoherent");
  });

  Deno.test("assertCandidateChecksSatisfied throws a state conflict that names what blocks", () => {
    const verdict = evaluateCandidateChecks({
      requirements: [
        required("command", "unit"),
        required("title", "changeRequest.semanticTitle"),
        required("command", "lint", "warn"),
      ],
      rows: [rowFor.command({ result: "failed", reason: "exit_nonzero" })],
      current: currentIdentity(),
    });
    const error = assertThrows(
      () => assertCandidateChecksSatisfied(verdict),
      StandardError,
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, DELIVERY_CHECKS_BLOCKED_REASON);
    assertEquals(error.params?.reason, "delivery_checks_blocked");
    assertEquals(error.params?.blockedCheckIds, [
      "unit",
      "changeRequest.semanticTitle",
    ]);
    assertEquals(error.params?.blocked, [
      {
        kind: "command",
        checkId: "unit",
        status: "failed",
        reason: "exit_nonzero",
      },
      {
        kind: "title",
        checkId: "changeRequest.semanticTitle",
        status: "missing",
        reason: "no_row",
      },
    ]);
  });
}

export function registerFreshnessCases(): void {
  Deno.test("every identity a row is bound to is exposed on the CheckRun projection", () => {
    const fields = transportType("CheckRun").fields as string[];
    for (const field of FRESHNESS_IDENTITY_FIELDS) {
      assert(fields.includes(field), `CheckRun lacks ${field}`);
    }
    assertEquals(
      new Set(fields).size,
      fields.length,
      "CheckRun lists a field twice",
    );
  });
  registerMatrix();
  registerVerdict();
  registerMetadataCases();
}
