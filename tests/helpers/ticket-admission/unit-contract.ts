import { issueNumberFromRef } from "../../../apps/server/src/modules/integrations/ticket-reads.ts";
import { ticketRef } from "../../../apps/server/src/modules/work/ticket-source-reader.ts";
import { assert, assertEquals, assertFalse } from "@std/assert";
import { z } from "zod";
import {
  defaultTicketSourcePolicy,
  isNonterminalTicketDisposition,
  isTerminalTicketDisposition,
  isTicketAutoResumableReason,
  isTicketCheckId,
  isTicketExplicitResumeReason,
  isTicketReasonCode,
  isTicketRequestDisposition,
  isTicketRequestIntent,
  isTicketRequestOrigin,
  NONTERMINAL_TICKET_DISPOSITIONS,
  TERMINAL_TICKET_DISPOSITIONS,
  TICKET_AUTO_RESUMABLE_REASONS,
  TICKET_CHECK_IDS,
  TICKET_CHECK_MAX_EVIDENCE,
  TICKET_CHECK_REASONS,
  TICKET_CHECK_STATUSES,
  TICKET_DELEGATION_MAX_ACTORS,
  TICKET_EXPLICIT_RESUME_REASONS,
  TICKET_LABEL_NAME_MAX_LENGTH,
  TICKET_NON_SUSPENDING_REASONS,
  TICKET_PROVIDER_BODY_MAX_CODE_POINTS,
  TICKET_REASON_CODES,
  TICKET_REPORT_MAX_CHECKS,
  TICKET_REPORT_VERDICTS,
  TICKET_REQUEST_DISPOSITIONS,
  TICKET_REQUEST_INTENTS,
  TICKET_REQUEST_ORIGINS,
  TICKET_SNAPSHOT_BODY_MAX_LENGTH,
  TICKET_SNAPSHOT_MAX_BLOCKERS,
  TICKET_SNAPSHOT_MAX_LABELS,
  TICKET_SNAPSHOT_TITLE_MAX_LENGTH,
  TicketAuthorityEvidenceSchema,
  TicketPresetPinSchema,
  TicketReadinessReportSchema,
  TicketSnapshotInputSchema,
  TicketSnapshotSchema,
  TicketSourcePolicyInputSchema,
  TicketSourcePolicySchema,
  TicketStoredReportSchema,
  ticketVerdictFromChecks,
} from "../../../packages/contracts/src/ticket-admission.ts";
import type {
  TicketFactIndex,
  TicketSourceHandle,
  TicketSourceReader,
} from "./fixtures.ts";

/**
 * Issue 82 contract module: the reason sets, the policy schemas, the snapshot
 * and report shapes, and the migration predicate stay one definition.
 */

const SHA = "a".repeat(64);
const ISO = "2026-11-01T00:00:00.000Z";

function overlap(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function validPolicy() {
  return structuredClone(defaultTicketSourcePolicy()) as Record<
    string,
    unknown
  >;
}

Deno.test("issue 82 contract: the three reason sets are pairwise disjoint and TICKET_REASON_CODES is their union", () => {
  assertEquals(
    overlap(TICKET_AUTO_RESUMABLE_REASONS, TICKET_EXPLICIT_RESUME_REASONS),
    [],
  );
  assertEquals(
    overlap(TICKET_AUTO_RESUMABLE_REASONS, TICKET_NON_SUSPENDING_REASONS),
    [],
  );
  assertEquals(
    overlap(TICKET_EXPLICIT_RESUME_REASONS, TICKET_NON_SUSPENDING_REASONS),
    [],
  );
  const union = [
    ...TICKET_AUTO_RESUMABLE_REASONS,
    ...TICKET_EXPLICIT_RESUME_REASONS,
    ...TICKET_NON_SUSPENDING_REASONS,
  ];
  assertEquals([...TICKET_REASON_CODES], union);
  assertEquals(
    new Set(TICKET_REASON_CODES).size,
    TICKET_REASON_CODES.length,
    "no reason code appears twice",
  );
  for (const code of TICKET_REASON_CODES) {
    assertEquals(
      [
        isTicketAutoResumableReason(code),
        isTicketExplicitResumeReason(code),
        TICKET_NON_SUSPENDING_REASONS.some((reason) => reason === code),
      ].filter(Boolean).length,
      1,
      `${code} belongs to exactly one set`,
    );
  }
  assert(isTicketReasonCode("held"));
  assertFalse(isTicketReasonCode("made_up"));
  assertFalse(isTicketReasonCode(undefined));
});

Deno.test("issue 82 contract: every reason a check can emit is in exactly one set, and no reason is orphaned", () => {
  assertEquals(
    Object.keys(TICKET_CHECK_REASONS).sort(),
    [...TICKET_CHECK_IDS].sort(),
    "a reason list exists for each check id",
  );
  const emitted = new Set<string>(["ok"]);
  for (const [id, reasons] of Object.entries(TICKET_CHECK_REASONS)) {
    for (const reason of reasons) {
      emitted.add(reason);
      assert(isTicketReasonCode(reason), `${id} emits unknown ${reason}`);
      assertEquals(
        [
          TICKET_AUTO_RESUMABLE_REASONS.some((code) => code === reason),
          TICKET_EXPLICIT_RESUME_REASONS.some((code) => code === reason),
          TICKET_NON_SUSPENDING_REASONS.some((code) => code === reason),
        ].filter(Boolean).length,
        1,
        `${id}: ${reason} belongs to exactly one set`,
      );
    }
  }
  assertEquals(
    TICKET_REASON_CODES.filter((code) => !emitted.has(code)),
    [],
    "every reason code is emitted by some check or is ok",
  );
});

Deno.test("issue 82 contract: dispositions split into nonterminal, terminal and pending", () => {
  assertEquals(
    [
      "pending",
      ...NONTERMINAL_TICKET_DISPOSITIONS,
      ...TERMINAL_TICKET_DISPOSITIONS,
    ].sort(),
    [...TICKET_REQUEST_DISPOSITIONS].sort(),
  );
  assert(isNonterminalTicketDisposition("suspended"));
  assertFalse(isNonterminalTicketDisposition("pending"));
  assertFalse(isNonterminalTicketDisposition("failed"));
});

Deno.test("issue 82 contract: the vocabulary lists hold exactly the documented members, in order", () => {
  assertEquals([...TICKET_REQUEST_INTENTS], ["plan", "start"]);
  assertEquals(
    [...TICKET_REQUEST_ORIGINS],
    ["manual", "adoption", "webhook", "poll"],
  );
  assertEquals([...TICKET_REQUEST_DISPOSITIONS], [
    "pending",
    "waiting",
    "admitted",
    "active",
    "suspended",
    "rejected",
    "completed",
    "failed",
    "canceled",
  ]);
  assertEquals(
    [...NONTERMINAL_TICKET_DISPOSITIONS],
    ["waiting", "admitted", "active", "suspended"],
  );
  assertEquals(
    [...TERMINAL_TICKET_DISPOSITIONS],
    ["rejected", "completed", "failed", "canceled"],
  );
  assertEquals([...TICKET_CHECK_IDS], [
    "source_live",
    "ticket_supported",
    "not_held",
    "intent_authorized",
    "epic_excluded",
    "acceptance_present",
    "status_ready",
    "dependencies_satisfied",
    "no_active_admission",
    "repository_ready",
    "preset_ready",
    "authority_live",
    "requirements_unchanged",
  ]);
  assertEquals([...TICKET_CHECK_STATUSES], ["pass", "wait", "reject"]);
  assertEquals([...TICKET_REPORT_VERDICTS], ["ready", "waiting", "rejected"]);

  for (const intent of ["plan", "start"]) {
    assert(isTicketRequestIntent(intent), intent);
  }
  for (const origin of ["manual", "adoption", "webhook", "poll"]) {
    assert(isTicketRequestOrigin(origin), origin);
  }
  assert(isTicketRequestDisposition("failed"));
  assert(isTerminalTicketDisposition("failed"));
  assertFalse(isTerminalTicketDisposition("suspended"));
  assertFalse(isTerminalTicketDisposition("pending"));
  assert(isTicketCheckId("requirements_unchanged"));
  assertFalse(isTicketCheckId("made_up"));
  assertFalse(isTicketRequestIntent("made_up"));
  assertFalse(isTicketRequestOrigin("made_up"));
  assertFalse(isTicketRequestDisposition("made_up"));
});

Deno.test("issue 82 contract: the body, title, label and list caps are the documented numbers", () => {
  assertEquals(TICKET_SNAPSHOT_BODY_MAX_LENGTH, 20_000);
  assertEquals(TICKET_PROVIDER_BODY_MAX_CODE_POINTS, 65_536);
  assertEquals(TICKET_SNAPSHOT_TITLE_MAX_LENGTH, 500);
  assertEquals(TICKET_LABEL_NAME_MAX_LENGTH, 50);
  assertEquals(TICKET_DELEGATION_MAX_ACTORS, 25);
  assertEquals(TICKET_SNAPSHOT_MAX_LABELS, 50);
  assertEquals(TICKET_SNAPSHOT_MAX_BLOCKERS, 50);
  assertEquals(TICKET_CHECK_MAX_EVIDENCE, 5);
  assertEquals(TICKET_REPORT_MAX_CHECKS, 13);
});

type TransportField = { name: string; enum?: string[] };
type Transport = {
  inputs: Record<string, { fields: TransportField[] }>;
  outputs: Record<
    string,
    { fields: string[]; fieldTypes: Record<string, string> }
  >;
  projections: Record<
    string,
    {
      fields: string[];
      fieldTypes: Record<string, string>;
      sourceColumns: Record<string, string>;
    }
  >;
};

async function readTransport(): Promise<Transport> {
  return JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../docs/technical-design/transport-schemas.json",
        import.meta.url,
      ),
    ),
  ) as Transport;
}

/** The members of a transport `enum(a|b|c)` field type. */
function enumMembers(fieldType: string | undefined): string[] {
  const match = /^enum\(([^)]*)\)$/.exec(fieldType ?? "");
  assert(match, `${fieldType} is an enum field type`);
  return match[1].split("|");
}

Deno.test("issue 82 contract: the TypeScript vocabulary equals the transport enums for TicketRequest and ticket_requests", async () => {
  const transport = await readTransport();
  for (
    const shape of [
      transport.outputs.TicketRequest,
      transport.projections.ticket_requests,
    ]
  ) {
    assert(shape, "the transport names TicketRequest and ticket_requests");
    assertEquals(
      enumMembers(shape.fieldTypes.disposition),
      [...TICKET_REQUEST_DISPOSITIONS],
    );
    assertEquals(
      enumMembers(shape.fieldTypes.origin),
      [...TICKET_REQUEST_ORIGINS],
    );
    assertEquals(
      enumMembers(shape.fieldTypes.intent),
      [...TICKET_REQUEST_INTENTS],
    );
  }
  const create = transport.inputs.TicketRequestCreate.fields.find((field) =>
    field.name === "intent"
  );
  assertEquals(create?.enum, [...TICKET_REQUEST_INTENTS]);
});

Deno.test("issue 82 contract: the receipt key refuses a duplicate that names no registration", async () => {
  // The behavioural half of this lives in the schema lane, where two null
  // registrations are inserted and the second is refused. This half exists
  // because that test cannot run without a database: dropping the clause below
  // leaves a plain unique, whose NULLs are all distinct, and nothing else in
  // the tree would say so.
  const sql = await Deno.readTextFile(
    new URL(
      "../../../apps/server/src/modules/work/migrations/bakery/0206_provider_neutral_ticket_sources.sql",
      import.meta.url,
    ),
  );
  const receipt = /add constraint inbound_events_delivery_unique([\s\S]*?);/
    .exec(sql);
  assert(receipt, "0206 rebuilds the receipt key");
  assert(
    /unique\s+nulls\s+not\s+distinct\s*\(registration_id,\s*external_delivery_id\)/i
      .test(receipt[1]),
    "the receipt key must treat null registrations as one value",
  );
  // Rebuilt, not added beside the old key: dropping and adding in one statement
  // is what keeps a window without the constraint from existing.
  assert(
    /drop constraint inbound_events_delivery_unique/.test(sql),
    "the old key is dropped in the same statement",
  );
});

Deno.test("issue 82 contract: the ticket_requests projection names the migration's columns", async () => {
  const transport = await readTransport();
  const projection = transport.projections.ticket_requests;
  // `targets` (#31) is read from bakery.ticket_request_targets, the
  // request's children, not from a ticket_requests column.
  assertEquals(
    [...transport.outputs.TicketRequest.fields].filter((field) =>
      field !== "targets"
    ).sort(),
    [...projection.fields].sort(),
    "the output and its projection list the same fields",
  );
  assertEquals(
    transport.outputs.TicketRequest.fields.filter((field) =>
      !projection.fields.includes(field)
    ),
    ["targets"],
  );
  const sql = await Deno.readTextFile(
    new URL(
      "../../../apps/server/src/modules/work/migrations/bakery/0145_ticket_admission.sql",
      import.meta.url,
    ),
  );
  const table = /create table bakery\.ticket_requests \(([\s\S]*?)\n\);/
    .exec(sql);
  assert(table, "the migration defines bakery.ticket_requests");
  const columns = [
    ...table[1].matchAll(
      /^ {2}([a-z_]+) (?:uuid|text|integer|jsonb|timestamptz)\b/gm,
    ),
  ].map((match) => match[1]);
  const projected = projection.fields.map((field) =>
    projection.sourceColumns[field]
  );
  // plan_artifact_version_id is a contract field with no column in this
  // delivery (always null); authority_evidence is the one stored column the
  // safe projection withholds.
  assertEquals(
    projected.filter((column) => !columns.includes(column)),
    ["plan_artifact_version_id"],
  );
  assertEquals(
    columns.filter((column) => !projected.includes(column)),
    ["authority_evidence"],
  );
  assertEquals(
    ["origin", "disposition", "disposition_reason", "readiness_report_id"]
      .filter((column) => !columns.includes(column)),
    [],
  );
});

Deno.test("issue 61 contract: the policy and the preset pin accept exactly the built-in workflows", () => {
  for (
    const schema of [TicketSourcePolicySchema, TicketSourcePolicyInputSchema]
  ) {
    const preset =
      (z.toJSONSchema(schema) as { properties: Record<string, object> })
        .properties.preset as { enum?: string[] };
    assertEquals(preset.enum, ["fixed-coding", "fixed-coding-reviewed"]);
    for (const id of ["fixed-coding", "fixed-coding-reviewed"]) {
      assertEquals(
        schema.safeParse({ ...validPolicy(), preset: id }).success,
        true,
        id,
      );
    }
    // A name outside the code-owned set, or a workflow id, is refused.
    for (const id of ["other-preset", crypto.randomUUID(), ""]) {
      assertEquals(
        schema.safeParse({ ...validPolicy(), preset: id }).success,
        false,
        id,
      );
    }
  }
  const pin = (id: string) =>
    TicketPresetPinSchema.safeParse({ id, revision: 1, digest: SHA }).success;
  assertEquals(pin("fixed-coding"), true);
  assertEquals(pin("fixed-coding-reviewed"), true);
  assertEquals(pin("other-preset"), false);
  const pinId = (z.toJSONSchema(TicketPresetPinSchema) as {
    properties: Record<string, { enum?: string[] } & object>;
  }).properties.id;
  assertEquals(pinId.enum, ["fixed-coding", "fixed-coding-reviewed"]);
});

Deno.test("issue 82 contract: the migration's one-nonterminal predicate lists exactly the nonterminal dispositions", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../../apps/server/src/modules/work/migrations/bakery/0145_ticket_admission.sql",
      import.meta.url,
    ),
  );
  const index =
    /create unique index ticket_requests_one_nonterminal_idx[\s\S]*?where disposition in \(([^)]*)\)/
      .exec(sql);
  assert(index, "the migration defines ticket_requests_one_nonterminal_idx");
  const listed = [...index[1].matchAll(/'([a-z_]+)'/g)].map((match) =>
    match[1]
  );
  assertEquals(listed, [...NONTERMINAL_TICKET_DISPOSITIONS]);
});

Deno.test("issue 82 contract: the default policy is valid, strict and carries the documented labels", () => {
  const policy = defaultTicketSourcePolicy();
  assertEquals(TicketSourcePolicySchema.safeParse(policy).success, true);
  assertEquals(policy.labels, {
    execute: "ready for agent",
    planOnly: "ready for planning",
    hold: "bakery:hold",
  });
  assertEquals(policy.version, 1);
  assertEquals(policy.delegation, null);
  assertEquals(policy.automatic, { enabled: false, since: null });
  assertEquals(
    policy.approval,
    { plan: "human_approval" },
    "a start intent waits for a human-approved plan by default",
  );
  assertEquals(
    policy.readiness,
    { requireAcceptanceCriteria: true },
    "acceptance criteria are required by default",
  );
  assertEquals(policy.preset, "fixed-coding");
  // A fresh object each call: a caller cannot change another caller's default.
  policy.labels.execute = "changed";
  assertEquals(defaultTicketSourcePolicy().labels.execute, "ready for agent");
  assertEquals(
    TicketSourcePolicySchema.safeParse({ ...validPolicy(), extra: true })
      .success,
    false,
    "an unknown key is refused",
  );
  assertEquals(
    TicketSourcePolicySchema.safeParse({ ...validPolicy(), version: 2 })
      .success,
    false,
  );
});

Deno.test("issue 82 contract: stored policy requires since when automatic is enabled, the input policy does not", () => {
  const enabledWithoutSince = {
    ...validPolicy(),
    automatic: { enabled: true, since: null },
  };
  assertEquals(
    TicketSourcePolicySchema.safeParse(enabledWithoutSince).success,
    false,
    "stored policy: enabled implies a non-null since",
  );
  assertEquals(
    TicketSourcePolicySchema.safeParse({
      ...validPolicy(),
      automatic: { enabled: true, since: ISO },
    }).success,
    true,
  );
  for (
    const automatic of [
      { enabled: true },
      { enabled: true, since: null },
      { enabled: true, since: ISO },
      { enabled: false, since: ISO },
    ]
  ) {
    assertEquals(
      TicketSourcePolicyInputSchema.safeParse({ ...validPolicy(), automatic })
        .success,
      true,
      `input accepts ${JSON.stringify(automatic)}`,
    );
  }
  assertEquals(
    TicketSourcePolicyInputSchema.safeParse({
      ...validPolicy(),
      automatic: { enabled: true, since: "yesterday" },
    }).success,
    false,
    "a since that is not a timestamp is still malformed",
  );
  assertEquals(
    TicketSourcePolicyInputSchema.safeParse({
      ...validPolicy(),
      automatic: { enabled: true, extra: 1 },
    }).success,
    false,
    "the input policy is strict too",
  );
});

Deno.test("issue 82 contract: policy bounds on labels and delegation", () => {
  const withLabels = (labels: Record<string, unknown>) =>
    TicketSourcePolicySchema.safeParse({
      ...validPolicy(),
      labels: { ...defaultTicketSourcePolicy().labels, ...labels },
    }).success;
  assertEquals(
    withLabels({ planOnly: null }),
    true,
    "planning label is optional",
  );
  assertEquals(withLabels({ execute: "bakery:hold" }), false, "labels differ");
  assertEquals(withLabels({ planOnly: "ready for agent" }), false);
  assertEquals(withLabels({ execute: "" }), false);
  assertEquals(withLabels({ execute: "x".repeat(51) }), false);
  assertEquals(withLabels({ execute: " padded" }), false);
  assertEquals(withLabels({ execute: "https://example.test/hook" }), false);
  assertEquals(withLabels({ execute: "${{ secrets.TOKEN }}" }), false);
  assertEquals(withLabels({ execute: "run`id`" }), false);
  assertEquals(withLabels({ execute: "line\nbreak" }), false);
  assertEquals(
    withLabels({ execute: "ready \u{1F680}" }),
    true,
    "emoji is fine",
  );

  const principalId = crypto.randomUUID();
  const withDelegation = (externalActorIds: unknown) =>
    TicketSourcePolicySchema.safeParse({
      ...validPolicy(),
      delegation: { principalId, externalActorIds },
    }).success;
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => String(1000 + index));
  assertEquals(withDelegation(ids(1)), true);
  assertEquals(withDelegation(ids(25)), true);
  assertEquals(withDelegation(ids(26)), false, "26 actors are too many");
  assertEquals(withDelegation([]), false, "at least one actor");
  // Opaque ids: a login, a UUID and a leading-zero key are all valid now, and
  // only the shape that is never an id is refused.
  assertEquals(
    withDelegation(["octocat"]),
    true,
    "an opaque id may be a login",
  );
  assertEquals(withDelegation(["012"]), true, "a leading zero is a valid id");
  assertEquals(withDelegation([""]), false, "an empty id is not an id");
  assertEquals(withDelegation([12]), false, "ids are strings");
  assertEquals(withDelegation(["12", "12"]), false, "ids are unique");
  assertEquals(
    TicketSourcePolicySchema.safeParse({
      ...validPolicy(),
      delegation: { principalId: "not-a-uuid", externalActorIds: ids(1) },
    }).success,
    false,
  );
});

Deno.test("issue 82 contract: snapshot bounds count UTF-16 code units and the reader input counts code points", () => {
  const snapshot = {
    title: "T",
    body: "x".repeat(20_000),
    bodyTruncated: false,
    labels: ["a"],
    state: "open",
    stateReason: null,
    locked: false,
    container: {
      kind: "repository",
      externalId: "owner/repo",
      displayName: "owner/repo",
    },
    links: null,
  };
  assertEquals(TicketSnapshotSchema.safeParse(snapshot).success, true);
  assertEquals(
    TicketSnapshotSchema.safeParse({
      ...snapshot,
      body: "x".repeat(20_001),
    }).success,
    false,
  );
  assertEquals(
    TicketSnapshotSchema.safeParse({ ...snapshot, title: "t".repeat(500) })
      .success,
    true,
  );
  assertEquals(
    TicketSnapshotSchema.safeParse({ ...snapshot, title: "t".repeat(501) })
      .success,
    false,
  );
  assertEquals(
    TicketSnapshotSchema.safeParse({
      ...snapshot,
      labels: Array.from({ length: 51 }, (_, index) => `l${index}`),
    }).success,
    false,
  );
  assertEquals(
    TicketSnapshotSchema.safeParse({
      ...snapshot,
      labels: ["see https://example.test/guide", "`odd` ${label}"],
      container: {
        kind: "repository",
        externalId: "octo_cat/repo.name",
        displayName: "octo_cat/repo.name",
      },
    }).success,
    true,
    "labels on an issue are evidence: whatever GitHub holds must be storable",
  );
  assertEquals(
    TicketSnapshotSchema.safeParse({
      ...snapshot,
      links: {
        parent: null,
        subIssuesTotal: 0,
        blockedBy: [],
        blockingTotal: 0,
      },
    }).success,
    true,
  );
  assertEquals(
    TicketSnapshotSchema.safeParse({ ...snapshot, extra: 1 }).success,
    false,
  );

  const input = {
    externalId: "42",
    number: 7,
    title: "T",
    body: "\u{1F600}".repeat(65_536),
    bodyTooLarge: false,
    labels: [],
    state: "open",
    stateReason: null,
    locked: false,
    container: {
      kind: "repository",
      externalId: "owner/repo",
      displayName: "owner/repo",
    },
  };
  assertEquals(
    TicketSnapshotInputSchema.safeParse(input).success,
    true,
    "65,536 astral code points are 131,072 UTF-16 units and still pass",
  );
  assertEquals(
    TicketSnapshotInputSchema.safeParse({
      ...input,
      body: "\u{1F600}".repeat(65_537),
    }).success,
    false,
  );
});

function check(id: string, status: string, reason: string) {
  return { id, status, reason, evidence: [] };
}

function report(
  verdict: string,
  checks: ReturnType<typeof check>[],
) {
  return {
    version: 1,
    verdict,
    checks,
    requirementsDigest: SHA,
    dependencyDigest: null,
    basisDigest: SHA,
    sourcePolicyRevision: 1,
    preset: { id: "fixed-coding", revision: 1, digest: SHA },
  };
}

Deno.test("issue 82 contract: a readiness report's verdict must follow from its checks", () => {
  const pass = check("source_live", "pass", "ok");
  const wait = check("not_held", "wait", "held");
  const reject = check("epic_excluded", "reject", "has_sub_issues");
  assertEquals(
    TicketReadinessReportSchema.safeParse(report("ready", [pass])).success,
    true,
  );
  assertEquals(
    TicketReadinessReportSchema.safeParse(report("waiting", [pass, wait]))
      .success,
    true,
  );
  assertEquals(
    TicketReadinessReportSchema.safeParse(
      report("rejected", [pass, wait, reject]),
    )
      .success,
    true,
    "a reject outranks a wait",
  );
  for (
    const bad of [
      report("ready", [pass, wait]),
      report("waiting", [pass]),
      report("waiting", [pass, reject]),
      report("rejected", [pass, wait]),
    ]
  ) {
    assertEquals(TicketReadinessReportSchema.safeParse(bad).success, false);
  }
  assertEquals(ticketVerdictFromChecks([]), "ready");
  assertEquals(
    TicketReadinessReportSchema.safeParse(report("ready", [])).success,
    false,
    "a report holds at least one check",
  );
  assertEquals(
    TicketReadinessReportSchema.safeParse(report("ready", [pass, pass]))
      .success,
    false,
    "each check id appears once",
  );
});

Deno.test("issue 82 contract: a check carries reason ok exactly when it passes", () => {
  const single = (status: string, reason: string) =>
    TicketReadinessReportSchema.safeParse(
      report(
        status === "pass"
          ? "ready"
          : status === "wait"
          ? "waiting"
          : "rejected",
        [check("not_held", status, reason)],
      ),
    ).success;
  assertEquals(single("pass", "ok"), true);
  assertEquals(single("pass", "held"), false);
  assertEquals(single("wait", "ok"), false);
  assertEquals(single("reject", "has_sub_issues"), true);
  assertEquals(single("wait", "not_a_reason"), false);
});

Deno.test("issue 82 contract: the reader port types accept every documented answer", async () => {
  const handle: TicketSourceHandle = {
    organizationId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    repositoryFullName: "owner/repo",
    provider: "github",
    externalRepositoryId: "1",
  };
  const unavailable = {
    kind: "unavailable",
    reason: "rate_limited",
    retryAfterSeconds: 30,
  } as const;
  const reader: TicketSourceReader = {
    readIssue: () => Promise.resolve({ kind: "gone" }),
    readLinks: () => Promise.resolve(unavailable),
    readStatuses: () => Promise.resolve({ kind: "unsupported" }),
    readPredecessorProof: () =>
      Promise.resolve({ kind: "proof_unavailable", detail: "events" }),
    readLabelProvenance: () => Promise.resolve({ kind: "absent" }),
    readActorRole: () => Promise.resolve({ kind: "absent" }),
    listIssues: () =>
      Promise.resolve({ kind: "present", numbers: [], hasNext: false }),
    readLabels: () => Promise.resolve({ kind: "unsupported" }),
  };
  const signal = new AbortController().signal;
  const issue = await reader.readIssue(handle, ticketRef(1), signal);
  assertEquals(issue.kind, "gone");
  const links = await reader.readLinks(handle, ticketRef(1), signal);
  assertEquals(links.kind, "unavailable");
  const index: TicketFactIndex = {
    listIssueNumbers: () => Promise.resolve([]),
  };
  assertEquals(typeof index.listIssueNumbers, "function");
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function storedReport(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    externalTicketId: crypto.randomUUID(),
    sequence: 2,
    report: {
      version: 1,
      verdict: "ready",
      checks: [{
        id: "source_live",
        status: "pass",
        reason: "ok",
        evidence: [],
      }],
      requirementsDigest: SHA_A,
      dependencyDigest: null,
      basisDigest: SHA_B,
      sourcePolicyRevision: 1,
      preset: { id: "fixed-coding", revision: 1, digest: SHA_A },
    },
    origin: "poll",
    evaluatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test("issue 82 contract: a stored report carries its per-ticket sequence beside the document", () => {
  const parsed = TicketStoredReportSchema.parse(storedReport());
  assertEquals(parsed.sequence, 2);
  assertEquals(parsed.report.version, 1);
  assertEquals(parsed.origin, "poll");
  for (
    const bad of [
      { sequence: 0 },
      { sequence: 1.5 },
      { origin: "cron" },
      { id: "not-a-uuid" },
      { evaluatedAt: "2026-07-01T00:00:00" },
      { extra: true },
    ]
  ) {
    assertFalse(
      TicketStoredReportSchema.safeParse(storedReport(bad)).success,
      JSON.stringify(bad),
    );
  }
  // The document still has to be a valid report: its verdict follows its checks.
  assertFalse(
    TicketStoredReportSchema.safeParse(
      storedReport({
        report: { ...storedReport().report, verdict: "rejected" },
      }),
    ).success,
  );
  const { origin: _origin, ...withoutOrigin } = storedReport();
  assertFalse(TicketStoredReportSchema.safeParse(withoutOrigin).success);
});

Deno.test("issue 82 contract: authority evidence names the principal and, for automatic origins, the labelling actor", () => {
  const evidence = {
    version: 1,
    origin: "webhook",
    labelBasis: "label",
    actingPrincipalId: crypto.randomUUID(),
    callerPrincipalId: null,
    provenance: {
      actorId: "4242",
      actorLogin: "labeler",
      appliedAt: "2026-07-01T00:00:00Z",
    },
    actorRole: { userId: "4242", permission: "write", rank: 2 },
  };
  assertEquals(
    TicketAuthorityEvidenceSchema.parse(evidence).labelBasis,
    "label",
  );
  const manual = {
    ...evidence,
    origin: "manual",
    labelBasis: "manual",
    callerPrincipalId: evidence.actingPrincipalId,
    provenance: null,
    actorRole: null,
  };
  assert(TicketAuthorityEvidenceSchema.safeParse(manual).success);
  for (
    const bad of [
      { version: 2 },
      { labelBasis: "implicit" },
      { actingPrincipalId: "admin" },
      // An actor id is opaque now, so a leading zero is a legitimate id and no
      // longer evidence of a malformed one; what is still refused is a role
      // name outside the provider's vocabulary and a rank that is not a number.
      { actorRole: { userId: "4242", permission: "owner", rank: 2 } },
      { actorRole: { userId: "4242", permission: "write" } },
      { extra: 1 },
    ]
  ) {
    assertFalse(
      TicketAuthorityEvidenceSchema.safeParse({ ...evidence, ...bad }).success,
      JSON.stringify(bad),
    );
  }
});

/**
 * The key parse, on its own, with the cases a reader-level test cannot name.
 *
 * `readIssue` refuses an unaddressable key by answering `unavailable`, which is
 * what a caller sees — but the parse has three independent guards, and a mutant
 * that drops one of them still fails closed when the *lookup* finds nothing. So
 * each guard gets a key that only it rejects:
 *
 * - `"0"` and `"-1"` are integers `Number.isSafeInteger` accepts, and `String()`
 *   round-trips them exactly; only `parsed > 0` rejects them.
 * - `"2.5"` and `""` fail the integer guard; `" 1"` and `"1.0"` fail the exact
 *   round-trip. Those are covered through the reader, and again here so the parse
 *   is pinned as a unit rather than only through a lookup that also fails closed.
 */
Deno.test("issue 82 key parse: a non-positive ordinal is refused, not turned into a ticket", () => {
  for (const key of ["0", "-1", "-5", "-0"]) {
    assertEquals(
      issueNumberFromRef(ticketRef(key)),
      null,
      `${JSON.stringify(key)} is not an ordinal any repository addresses`,
    );
  }
  // The same function still reads a real ordinal, so the guard is about the value
  // rather than about parsing at all.
  assertEquals(issueNumberFromRef(ticketRef("1")), 1);
  assertEquals(issueNumberFromRef(ticketRef("42")), 42);
});

Deno.test("issue 82 key parse: the id the caller supplied does not change the parse", () => {
  // The parse answers "which ordinal does this key name"; whether that ordinal is
  // the ticket the caller meant is `readIssue`'s check, against the id. Keeping
  // the two apart is what lets the parse stay a pure function of the key.
  assertEquals(issueNumberFromRef(ticketRef("7", "999")), 7);
  assertEquals(issueNumberFromRef(ticketRef("0", "999")), null);
});
