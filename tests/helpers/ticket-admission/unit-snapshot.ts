import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type {
  TicketIssueRef,
  TicketSnapshotInput,
} from "../../../packages/contracts/src/ticket-admission.ts";
import {
  TICKET_PROVIDER_BODY_MAX_CODE_POINTS,
  TICKET_SNAPSHOT_BODY_MAX_LENGTH,
  TicketSnapshotInputSchema,
  TicketSnapshotSchema,
} from "../../../packages/contracts/src/ticket-admission.ts";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import {
  basisDigest,
  type BlockerProofEntry,
  countCodePoints,
  cutUtf16,
  dependencyDigest,
  normalizeLinks,
  normalizeNewlines,
  normalizeSnapshot,
  requirementsDigest,
  sortIssueRefs,
  STORED_BODY_MAX_LENGTH,
  TASK_DESCRIPTION_FOOTER_RESERVE,
  taskDescriptionFooter,
} from "../../../apps/server/src/modules/work/ticket-snapshot.ts";

/**
 * Issue 82 unit lane: snapshot bounding and the digests. The requirements
 * digest moves with the title and the body only; the dependency digest moves
 * with the blockers and their proofs only; the stored body leaves room for the
 * task footer and never splits a surrogate pair.
 */

const MARKER = "2026-11-01T00:00:00Z";
const ASTRAL = "\u{1F600}";

function issueInput(
  overrides: Partial<TicketSnapshotInput> = {},
): TicketSnapshotInput {
  return {
    externalId: "4242",
    number: 12,
    title: "Add the export button",
    body: "Intro\n\n### Acceptance criteria\n- [ ] exports a file\n",
    bodyTooLarge: false,
    labels: ["ready for agent"],
    state: "open",
    stateReason: null,
    locked: false,
    repositoryFullName: "owner/repo",
    ...overrides,
  };
}

function normalized(overrides: Partial<TicketSnapshotInput> = {}) {
  return normalizeSnapshot(issueInput(overrides), {
    links: null,
    providerUpdatedAt: MARKER,
  });
}

function ref(number: number, repository = "owner/repo"): TicketIssueRef {
  return { id: String(9000 + number), number, repositoryFullName: repository };
}

function satisfied(number: number): BlockerProofEntry {
  return {
    blocker: ref(number),
    proof: {
      kind: "satisfied",
      pullRequestNumber: 70 + number,
      mergeSha: String(number).padStart(40, "a"),
      mergedAt: MARKER,
    },
  };
}

Deno.test("issue 82 unit snapshot: newline styles collapse to LF", () => {
  assertEquals(normalizeNewlines("a\r\nb\rc\nd\r\n\r\ne"), "a\nb\nc\nd\n\ne");
  assertEquals(normalizeNewlines("no breaks"), "no breaks");
  assertEquals(normalizeNewlines(""), "");
});

Deno.test("issue 82 unit snapshot: a normalized issue fits the stored schema and keeps its facts", () => {
  const value = normalizeSnapshot(
    issueInput({ title: "Line\r\nbreak", body: "one\r\ntwo\r\n" }),
    {
      links: {
        parent: null,
        subIssuesTotal: 0,
        blockedBy: [],
        blockingTotal: 2,
      },
      providerUpdatedAt: MARKER,
    },
  );
  assertEquals(TicketSnapshotSchema.safeParse(value.snapshot).success, true);
  assertEquals(value.snapshot.title, "Line\nbreak");
  assertEquals(value.snapshot.body, "one\ntwo\n");
  assertEquals(value.snapshot.bodyTruncated, false);
  assertEquals(value.snapshot.state, "open");
  assertEquals(value.snapshot.labels, ["ready for agent"]);
  assertEquals(value.snapshot.links?.blockingTotal, 2);
  assertEquals(value.body, "one\ntwo\n");
  assertEquals(value.tooLarge, false);
  assertEquals(value.providerUpdatedAt, MARKER);
});

Deno.test("issue 82 unit snapshot: title, label and blocker bounds", () => {
  const longTitle = normalized({ title: "t".repeat(700) });
  assertEquals(longTitle.snapshot.title.length, 500);
  const split = normalized({ title: `${"t".repeat(499)}${ASTRAL}` });
  assertEquals(split.snapshot.title, "t".repeat(499), "no lone surrogate");
  const labels = normalized({
    labels: Array.from({ length: 50 }, (_, index) => `label ${index}`),
  });
  assertEquals(labels.snapshot.labels.length, 50);
  const blockers = Array.from({ length: 60 }, (_, index) => ref(index + 1));
  const links = normalizeLinks({
    kind: "present",
    parent: null,
    subIssuesTotal: 0,
    blockedBy: [...blockers].reverse(),
    blockingTotal: 0,
    truncated: true,
  });
  assertEquals(links.blockedBy.length, 50);
  assertEquals(
    links.blockedBy.map((blocker) => blocker.number),
    Array.from({ length: 50 }, (_, index) => index + 1),
    "stored blockers are ordered, so the provider's order never matters",
  );
});

Deno.test("issue 82 unit snapshot: body length boundaries are counted in code points", () => {
  const limit = TICKET_PROVIDER_BODY_MAX_CODE_POINTS;
  assertEquals(limit, 65_536);
  const fixtures: [string, string][] = [
    ["ascii", "x"],
    ["two-byte", "é"],
    ["three-byte", "日"],
    ["four-byte astral", ASTRAL],
  ];
  for (const [name, character] of fixtures) {
    const atLimit = character.repeat(limit);
    assertEquals(countCodePoints(atLimit), limit, name);
    const kept = normalized({ body: atLimit });
    assertEquals(
      kept.tooLarge,
      false,
      `${name} at ${limit} code points is kept`,
    );
    assertEquals(kept.body, atLimit);
    assertEquals(
      TicketSnapshotInputSchema.safeParse(issueInput({ body: atLimit }))
        .success,
      true,
      `${name}: the reader input schema accepts the limit`,
    );
    const over = normalized({ body: character.repeat(limit + 1) });
    assertEquals(over.tooLarge, true, `${name} at ${limit + 1} is too large`);
    assertEquals(over.body, "");
    assertEquals(over.snapshot.body, "");
    assertEquals(over.snapshot.bodyTruncated, true);
    assertEquals(
      TicketSnapshotInputSchema.safeParse(
        issueInput({ body: character.repeat(limit + 1) }),
      ).success,
      false,
    );
  }
  const flagged = normalized({ body: "", bodyTooLarge: true });
  assertEquals(flagged.tooLarge, true, "the reader's flag is honored");
});

Deno.test("issue 82 unit snapshot: the stored body is cut by UTF-16 length and leaves room for the footer", () => {
  assertEquals(TASK_DESCRIPTION_FOOTER_RESERVE, 200);
  assertEquals(
    STORED_BODY_MAX_LENGTH,
    TICKET_SNAPSHOT_BODY_MAX_LENGTH - TASK_DESCRIPTION_FOOTER_RESERVE,
  );
  const short = normalized({ body: "x".repeat(STORED_BODY_MAX_LENGTH) });
  assertEquals(short.snapshot.bodyTruncated, false);
  assertEquals(short.snapshot.body.length, STORED_BODY_MAX_LENGTH);
  const cut = normalized({ body: "x".repeat(STORED_BODY_MAX_LENGTH + 1) });
  assertEquals(cut.snapshot.bodyTruncated, true);
  assertEquals(cut.snapshot.body.length, STORED_BODY_MAX_LENGTH);
  assertEquals(
    cut.body.length,
    STORED_BODY_MAX_LENGTH + 1,
    "the digest still sees the full normalized text",
  );
});

Deno.test("issue 82 unit snapshot: the cut never splits a surrogate pair, with the pair on either side of the boundary", () => {
  // "a" shifts the pairs onto odd offsets, so the boundary falls between the
  // halves of a pair; without the shift it falls between two pairs.
  const fixtures = [
    ASTRAL.repeat(STORED_BODY_MAX_LENGTH),
    `a${ASTRAL.repeat(STORED_BODY_MAX_LENGTH)}`,
    `${"b".repeat(STORED_BODY_MAX_LENGTH - 1)}${ASTRAL}${ASTRAL}`,
    `${"b".repeat(STORED_BODY_MAX_LENGTH - 2)}${ASTRAL}${ASTRAL}`,
  ];
  for (const body of fixtures) {
    const { snapshot } = normalized({ body });
    assert(snapshot.body.length <= STORED_BODY_MAX_LENGTH);
    assert(body.startsWith(snapshot.body), "the stored body is a prefix");
    const last = snapshot.body.charCodeAt(snapshot.body.length - 1);
    assertEquals(
      last >= 0xd800 && last <= 0xdbff,
      false,
      "the stored body does not end on a lone high surrogate",
    );
    // Round trip: encoding fails on a lone surrogate by replacing it.
    assertEquals(
      new TextDecoder().decode(new TextEncoder().encode(snapshot.body)),
      snapshot.body,
    );
    assertEquals(TicketSnapshotSchema.safeParse(snapshot).success, true);
  }
  assertEquals(cutUtf16("abc", 5), "abc");
  assertEquals(cutUtf16("abc", 2), "ab");
  assertEquals(cutUtf16(`a${ASTRAL}`, 2), "a");
  assertEquals(cutUtf16(`a${ASTRAL}`, 3), `a${ASTRAL}`);
  assertEquals(cutUtf16("", 0), "");
});

Deno.test("issue 82 unit snapshot: an astral body at the boundary passes the Zod bound and the code-point check, with its footer", () => {
  const footer = taskDescriptionFooter("owner/repo", 12_345);
  assertEquals(footer, "\n\nGitHub: owner/repo#12345");
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const description = (text: string) =>
    contractSchemas.TaskCreate.safeParse({
      applicationId,
      repositoryId,
      taskType: "feature",
      title: "t",
      description: text,
    }).success;
  assertEquals(description("x".repeat(20_000)), true);
  assertEquals(
    description("x".repeat(20_001)),
    false,
    "TaskCreate counts UTF-16 units against 20,000",
  );
  const owner = "o".repeat(39);
  const worst = taskDescriptionFooter(
    `${owner}/${"r".repeat(100)}`,
    2_147_483_647,
  );
  assert(
    worst.length <= TASK_DESCRIPTION_FOOTER_RESERVE,
    `the worst footer is ${worst.length} units`,
  );
  const bodies = [
    ASTRAL.repeat(STORED_BODY_MAX_LENGTH),
    `a${ASTRAL.repeat(STORED_BODY_MAX_LENGTH)}`,
    "x".repeat(STORED_BODY_MAX_LENGTH * 2),
  ];
  for (const body of bodies) {
    const stored = normalized({ body }).snapshot.body;
    for (const tail of [footer, worst]) {
      const full = `${stored}${tail}`;
      assert(full.length <= 20_000, "within the Zod bound (UTF-16 units)");
      assert(
        countCodePoints(full) <= 20_000,
        "within char_length (code points)",
      );
      assertEquals(description(full), true);
    }
  }
});

Deno.test("issue 82 unit snapshot: the requirements digest hashes the canonical title and full body", async () => {
  const subject = normalized({ title: "T", body: "line one\r\nline two" });
  assertEquals(
    await requirementsDigest(subject),
    await sha256Hex(
      canonicalJson({ title: "T", body: "line one\nline two" }),
    ),
  );
  assert(/^[0-9a-f]{64}$/.test(await requirementsDigest(subject)));
});

Deno.test("issue 82 unit snapshot: the requirements digest ignores key order and newline style", async () => {
  const base = await requirementsDigest(
    normalized({ title: "T", body: "a\nb\n\nc" }),
  );
  assertEquals(
    await requirementsDigest(
      normalized({ title: "T", body: "a\r\nb\r\n\r\nc" }),
    ),
    base,
    "CRLF",
  );
  assertEquals(
    await requirementsDigest(normalized({ title: "T", body: "a\rb\r\rc" })),
    base,
    "CR",
  );
  const reordered = TicketSnapshotInputSchema.parse({
    repositoryFullName: "owner/repo",
    locked: false,
    stateReason: null,
    state: "open",
    labels: [],
    bodyTooLarge: false,
    body: "a\nb\n\nc",
    title: "T",
    number: 12,
    externalId: "4242",
  });
  assertEquals(
    await requirementsDigest(
      normalizeSnapshot(reordered, { links: null, providerUpdatedAt: MARKER }),
    ),
    base,
    "input key order",
  );
});

Deno.test("issue 82 unit snapshot: labels, state, timestamps and links do not move the requirements digest, a title or body change does", async () => {
  const input = issueInput();
  const base = await requirementsDigest(
    normalizeSnapshot(input, { links: null, providerUpdatedAt: MARKER }),
  );
  const same = async (change: Partial<TicketSnapshotInput>, marker = MARKER) =>
    await requirementsDigest(
      normalizeSnapshot(
        { ...input, ...change },
        { links: null, providerUpdatedAt: marker },
      ),
    );
  assertEquals(await same({ labels: [] }), base, "labels");
  assertEquals(
    await same({ labels: ["ready for agent", "bakery:hold"] }),
    base,
  );
  assertEquals(
    await same({ state: "closed", stateReason: "completed" }),
    base,
    "state",
  );
  assertEquals(await same({ locked: true }), base, "locked");
  assertEquals(
    await same({}, "2027-01-01T00:00:00Z"),
    base,
    "provider timestamp",
  );
  assertEquals(
    await requirementsDigest(
      normalizeSnapshot(input, {
        links: {
          parent: ref(1),
          subIssuesTotal: 3,
          blockedBy: [ref(2)],
          blockingTotal: 1,
        },
        providerUpdatedAt: MARKER,
      }),
    ),
    base,
    "links",
  );
  assertNotEquals(await same({ body: `${input.body}more` }), base, "body");
  assertNotEquals(
    await same({ title: "Add the import button" }),
    base,
    "title",
  );
  assertNotEquals(
    await same({ body: input.body.replace("exports", "imports") }),
    base,
  );
  assertNotEquals(
    await same({ body: `${input.body} ` }),
    base,
    "trailing whitespace is content",
  );
});

Deno.test("issue 82 unit snapshot: a too-large body hashes the title and the provider marker", async () => {
  const large = (title: string, marker: string) =>
    normalizeSnapshot(
      issueInput({ title, body: "", bodyTooLarge: true }),
      { links: null, providerUpdatedAt: marker },
    );
  const base = await requirementsDigest(large("T", MARKER));
  assertEquals(await requirementsDigest(large("T", MARKER)), base);
  assertNotEquals(
    await requirementsDigest(large("T", "2027-01-01T00:00:00Z")),
    base,
  );
  assertNotEquals(await requirementsDigest(large("Other", MARKER)), base);
  assertEquals(
    base,
    await sha256Hex(
      canonicalJson({ title: "T", tooLarge: true, providerUpdatedAt: MARKER }),
    ),
  );
  assert(/^[0-9a-f]{64}$/.test(base), "always a string for the ticket row");
});

Deno.test("issue 82 unit snapshot: the dependency digest moves with blockers and proofs only", async () => {
  const links = { blockedBy: [ref(1), ref(2)] };
  const proofs = [satisfied(1), satisfied(2)];
  const base = await dependencyDigest(links, proofs);
  assert(/^[0-9a-f]{64}$/.test(base));
  assertEquals(
    await dependencyDigest(
      { blockedBy: [ref(2), ref(1)] },
      [...proofs].reverse(),
    ),
    base,
    "order of blockers and proofs",
  );
  assertEquals(
    await dependencyDigest(links, [
      {
        blocker: ref(1),
        proof: {
          kind: "satisfied",
          pullRequestNumber: 999,
          mergeSha: String(1).padStart(40, "a"),
          mergedAt: "2030-01-01T00:00:00Z",
        },
      },
      satisfied(2),
    ]),
    base,
    "pull request number and merge time are not identity",
  );
  assertNotEquals(
    await dependencyDigest({ blockedBy: [ref(1), ref(2), ref(3)] }, [
      ...proofs,
      satisfied(3),
    ]),
    base,
    "a new blocker",
  );
  assertNotEquals(
    await dependencyDigest({ blockedBy: [ref(1)] }, [satisfied(1)]),
    base,
    "a removed blocker",
  );
  assertNotEquals(
    await dependencyDigest(links, [
      satisfied(1),
      { blocker: ref(2), proof: { kind: "open" } },
    ]),
    base,
    "a proof kind",
  );
  assertNotEquals(
    await dependencyDigest(links, [
      satisfied(1),
      {
        blocker: ref(2),
        proof: {
          kind: "satisfied",
          pullRequestNumber: 72,
          mergeSha: "b".repeat(40),
          mergedAt: MARKER,
        },
      },
    ]),
    base,
    "a merge sha",
  );
  assertNotEquals(
    await dependencyDigest(links, [satisfied(1)]),
    base,
    "a missing proof",
  );
  assertEquals(
    await dependencyDigest(links, [
      satisfied(1),
      { blocker: ref(2), proof: { kind: "proof_unavailable", detail: "a" } },
    ]),
    await dependencyDigest(links, [
      satisfied(1),
      { blocker: ref(2), proof: { kind: "proof_unavailable", detail: "b" } },
    ]),
    "proof detail text is not part of it",
  );
  assertNotEquals(
    await dependencyDigest(links, [
      satisfied(1),
      {
        blocker: ref(2),
        proof: {
          kind: "unavailable",
          reason: "timeout",
          retryAfterSeconds: null,
        },
      },
    ]),
    base,
    "a failed read is not a satisfied proof",
  );
  assertEquals(
    (await dependencyDigest({ blockedBy: [] }, [])).length,
    64,
    "no blockers still hashes",
  );
});

Deno.test("issue 82 unit snapshot: a link change moves only the dependency digest", async () => {
  const snapshot = normalized();
  const requirementsBefore = await requirementsDigest(snapshot);
  const before = await dependencyDigest({ blockedBy: [] }, []);
  const after = await dependencyDigest({ blockedBy: [ref(3)] }, [satisfied(3)]);
  assertNotEquals(before, after);
  assertEquals(await requirementsDigest(snapshot), requirementsBefore);
});

Deno.test("issue 82 unit snapshot: issue references sort by repository, number, then id", () => {
  const sorted = sortIssueRefs([
    ref(5, "owner/zeta"),
    ref(3),
    ref(2, "owner/alpha"),
    { id: "1", number: 3, repositoryFullName: "owner/repo" },
  ]);
  assertEquals(
    sorted.map((entry) =>
      `${entry.repositoryFullName}#${entry.number}:${entry.id}`
    ),
    [
      "owner/alpha#2:9002",
      "owner/repo#3:1",
      "owner/repo#3:9003",
      "owner/zeta#5:9005",
    ],
  );
});

Deno.test("issue 82 unit snapshot: the basis digest is stable and moves with each part", async () => {
  const preset = {
    id: "fixed-coding" as const,
    revision: 1,
    digest: "c".repeat(64),
  };
  const parts = {
    requirementsDigest: "a".repeat(64),
    dependencyDigest: "b".repeat(64),
    sourcePolicyRevision: 3,
    preset,
    intent: "start" as const,
    labelBasis: "label" as const,
    hold: false,
    checks: [{ id: "source_live", status: "pass", reason: "ok" }],
  };
  const base = await basisDigest(parts);
  assertEquals(await basisDigest(structuredClone(parts)), base);
  const variants = [
    { ...parts, requirementsDigest: "d".repeat(64) },
    { ...parts, requirementsDigest: null },
    { ...parts, dependencyDigest: "d".repeat(64) },
    { ...parts, dependencyDigest: null },
    { ...parts, sourcePolicyRevision: 4 },
    { ...parts, preset: { ...preset, revision: 2 } },
    { ...parts, preset: { ...preset, digest: "d".repeat(64) } },
    { ...parts, intent: "plan" as const },
    { ...parts, labelBasis: "manual" as const },
    { ...parts, hold: true },
    {
      ...parts,
      checks: [{
        id: "source_live",
        status: "wait",
        reason: "source_disabled",
      }],
    },
  ];
  const seen = new Set([base]);
  for (const variant of variants) seen.add(await basisDigest(variant));
  assertEquals(seen.size, variants.length + 1, "each variant is a new basis");
});
