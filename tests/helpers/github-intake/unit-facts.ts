import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import {
  boundFactSummary,
  FACT_MAX_LABEL_LENGTH,
  FACT_MAX_LABELS,
  FACT_MAX_SUMMARY_BYTES,
  factDigest,
  type FactProjection,
  isNewer,
  type ObservationOrder,
  RemoteFactSchema,
  RemoteFactSummarySchema,
} from "../../../apps/server/src/modules/integrations/remote-facts.ts";
import {
  PullRequestObservationSchema,
  PullRequestStatus,
  pullRequestStatus,
  TrackedPullRequestQuerySchema,
} from "../../../apps/server/src/modules/integrations/pull-requests.ts";

const at = (iso: string) => new Date(iso);
const order = (provider: string, started: string): ObservationOrder => ({
  providerUpdatedAt: at(provider),
  observedStartedAt: at(started),
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";

const issue = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION,
  resourceId: RESOURCE,
  kind: "issue",
  externalId: "1001",
  number: 7,
  headSha: null,
  state: "open",
  conclusion: null,
  providerUpdatedAt: at("2026-10-31T10:00:00.000Z"),
  observedStartedAt: at("2026-10-31T10:00:05.000Z"),
  summary: { labels: ["bug"], locked: false, stateReason: null },
  ...overrides,
});

Deno.test("issue 71 isNewer orders by provider time first, then by read start", () => {
  const stored = order("2026-10-31T10:00:00Z", "2026-10-31T10:00:30Z");
  // A greater provider time wins even when its read began earlier.
  assert(
    isNewer(order("2026-10-31T10:00:01Z", "2026-10-31T10:00:01Z"), stored),
  );
  // A lesser provider time loses even when its read began later.
  assertFalse(
    isNewer(order("2026-10-31T09:59:59Z", "2026-10-31T11:00:00Z"), stored),
  );
  // Equal provider time: the later read start wins.
  assert(
    isNewer(order("2026-10-31T10:00:00Z", "2026-10-31T10:00:31Z"), stored),
  );
  // Equal provider time and an earlier read start loses.
  assertFalse(
    isNewer(order("2026-10-31T10:00:00Z", "2026-10-31T10:00:29Z"), stored),
  );
  // Equal markers are not newer: an equal read replaces nothing.
  assertFalse(isNewer(stored, stored));
  assertFalse(isNewer({ ...stored }, { ...stored }));
  // Separate Date objects compare by instant, not identity.
  assertFalse(
    isNewer(
      order("2026-10-31T10:00:00.000Z", "2026-10-31T10:00:30.000Z"),
      order("2026-10-31T10:00:00.000Z", "2026-10-31T10:00:30.000Z"),
    ),
  );
  // Nothing stored yet: any observation is newer.
  assert(isNewer(stored, null));
});

Deno.test("issue 71 factDigest is stable across key order and moves with every field", async () => {
  const base: FactProjection = {
    number: 7,
    headSha: null,
    state: "open",
    conclusion: null,
    providerUpdatedAt: at("2026-10-31T10:00:00.000Z"),
    summary: { labels: ["bug", "p1"], locked: false, stateReason: null },
  };
  const digest = await factDigest(base);
  assertMatch(digest, /^[0-9a-f]{64}$/);
  // Same state, object keys in another order, equal instants in new objects.
  const reordered: FactProjection = {
    summary: { stateReason: null, locked: false, labels: ["bug", "p1"] },
    providerUpdatedAt: at("2026-10-31T10:00:00.000Z"),
    conclusion: null,
    state: "open",
    headSha: null,
    number: 7,
  };
  assertEquals(await factDigest(reordered), digest);
  const changes: Partial<FactProjection>[] = [
    { number: 8 },
    { headSha: SHA_A },
    { state: "closed" },
    { conclusion: "success" },
    { providerUpdatedAt: at("2026-10-31T10:00:01.000Z") },
    { summary: { ...base.summary, labels: ["p1", "bug"] } },
    { summary: { ...base.summary, locked: true } },
    { summary: { ...base.summary, stateReason: "completed" } },
  ];
  for (const change of changes) {
    assertNotEquals(
      await factDigest({ ...base, ...change }),
      digest,
      JSON.stringify(change),
    );
  }
});

Deno.test("issue 71 fact summary keeps 50 labels of 50 characters and refuses a body", () => {
  assert(
    RemoteFactSummarySchema.safeParse({
      labels: Array.from({ length: FACT_MAX_LABELS }, () => "x"),
    }).success,
  );
  assertFalse(
    RemoteFactSummarySchema.safeParse({
      labels: Array.from({ length: FACT_MAX_LABELS + 1 }, () => "x"),
    }).success,
    "51 labels",
  );
  assert(
    RemoteFactSummarySchema.safeParse({
      labels: ["y".repeat(FACT_MAX_LABEL_LENGTH)],
    }).success,
  );
  assertFalse(
    RemoteFactSummarySchema.safeParse({
      labels: ["y".repeat(FACT_MAX_LABEL_LENGTH + 1)],
    }).success,
    "a 51 character label",
  );
  assertFalse(RemoteFactSummarySchema.safeParse({ labels: [""] }).success);
  // No free text rides along: the object is strict.
  assertFalse(
    RemoteFactSummarySchema.safeParse({ labels: [], body: "issue text" })
      .success,
    "an issue body",
  );
  assertFalse(
    RemoteFactSummarySchema.safeParse({ comments: ["hello"] }).success,
  );
});

Deno.test("issue 71 fact summary is limited to 2 KiB and boundFactSummary fits it", () => {
  // 50 labels of 50 characters are individually legal but together too large.
  const labels = Array.from(
    { length: FACT_MAX_LABELS },
    (_, index) =>
      `${index}`.padStart(2, "0").padEnd(FACT_MAX_LABEL_LENGTH, "z"),
  );
  assertFalse(RemoteFactSummarySchema.safeParse({ labels }).success);
  const bounded = boundFactSummary({ labels, locked: true });
  const parsed = RemoteFactSummarySchema.parse(bounded);
  assert(
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength <=
      FACT_MAX_SUMMARY_BYTES,
  );
  assertEquals(parsed.locked, true);
  // The prefix of the label list is kept, in order; only the tail is dropped.
  assertEquals(parsed.labels, labels.slice(0, parsed.labels?.length));
  assert(parsed.labels!.length > 0 && parsed.labels!.length < labels.length);
  // It also enforces the count and length bounds on over-long input.
  const clipped = boundFactSummary({
    labels: [
      "w".repeat(80),
      ...Array.from({ length: 80 }, () => "a"),
    ],
  });
  assertEquals(clipped.labels!.length, FACT_MAX_LABELS);
  assertEquals(clipped.labels![0], "w".repeat(FACT_MAX_LABEL_LENGTH));
  // A multi-unit character is never cut in half.
  const emoji = boundFactSummary({ labels: ["\u{1F600}".repeat(30)] });
  assertEquals(emoji.labels![0], "\u{1F600}".repeat(25));
  // A summary without labels is returned as is.
  const flags = { locked: false };
  assertEquals(boundFactSummary(flags), flags);
});

Deno.test("issue 71 fact needs the identity fields its kind implies", () => {
  assert(RemoteFactSchema.safeParse(issue()).success);
  assertFalse(
    RemoteFactSchema.safeParse(issue({ number: null })).success,
    "an issue without a number",
  );
  assert(
    RemoteFactSchema.safeParse(issue({
      kind: "check_run",
      externalId: "5001",
      number: null,
      headSha: SHA_A,
      state: "completed",
      conclusion: "success",
      summary: { name: "build", status: "completed", appId: 12 },
    })).success,
  );
  // A check run whose creating App GitHub no longer has is a valid fact: its
  // author is unknown, recorded as a null App id and slug.
  assert(
    RemoteFactSchema.safeParse(issue({
      kind: "check_run",
      externalId: "5002",
      number: null,
      headSha: SHA_A,
      state: "completed",
      conclusion: "success",
      summary: {
        name: "build",
        status: "completed",
        appId: null,
        appSlug: null,
      },
    })).success,
    "a check run with a null App",
  );
  assertFalse(
    RemoteFactSummarySchema.safeParse({ appId: "12" }).success,
    "an App id that is text",
  );
  assertFalse(
    RemoteFactSummarySchema.safeParse({ appSlug: 7 }).success,
    "an App slug that is a number",
  );
  assertFalse(
    RemoteFactSchema.safeParse(issue({
      kind: "check_run",
      number: null,
      headSha: null,
    })).success,
    "a check run without a head SHA",
  );
  assertFalse(
    RemoteFactSchema.safeParse(issue({ headSha: "A".repeat(40) })).success,
    "an uppercase SHA",
  );
  assertFalse(RemoteFactSchema.safeParse(issue({ kind: "label" })).success);
  assertFalse(
    RemoteFactSchema.safeParse(issue({ providerUpdatedAt: new Date("x") }))
      .success,
    "an invalid date",
  );
  assertFalse(
    RemoteFactSchema.safeParse(issue({ extra: true })).success,
    "an unknown key",
  );
  assertFalse(
    RemoteFactSchema.safeParse(issue({ kind: "pull_request" })).success,
    "pull requests live in pull_requests, not in facts",
  );
});

Deno.test("issue 71 a closed and merged pull request is stored as merged", () => {
  assertEquals(
    pullRequestStatus({ state: "open", merged: false }),
    PullRequestStatus.Open,
  );
  assertEquals(
    pullRequestStatus({ state: "closed", merged: false }),
    PullRequestStatus.Closed,
  );
  assertEquals(
    pullRequestStatus({ state: "closed", merged: true }),
    PullRequestStatus.Merged,
  );
  const observation = {
    organizationId: ORGANIZATION,
    number: 12,
    state: "closed",
    merged: true,
    url: "https://github.com/o/r/pull/12",
    headSha: SHA_A,
    baseSha: SHA_B,
    mergedSha: SHA_B,
    providerUpdatedAt: at("2026-10-31T10:00:00.000Z"),
    observedStartedAt: at("2026-10-31T10:00:05.000Z"),
  };
  assert(PullRequestObservationSchema.safeParse(observation).success);
  assertFalse(
    PullRequestObservationSchema.safeParse({ ...observation, state: "open" })
      .success,
    "an open pull request cannot be merged",
  );
  assertFalse(
    PullRequestObservationSchema.safeParse({ ...observation, headSha: "abc" })
      .success,
    "a short SHA",
  );
});

Deno.test("issue 71 a tracked pull request lookup needs a number or a head SHA", () => {
  const base = {
    organizationId: ORGANIZATION,
    repositoryId: RESOURCE,
  };
  assertFalse(TrackedPullRequestQuerySchema.safeParse(base).success);
  assert(
    TrackedPullRequestQuerySchema.safeParse({ ...base, number: 3 }).success,
  );
  assert(
    TrackedPullRequestQuerySchema.safeParse({ ...base, headSha: SHA_A })
      .success,
  );
  assertFalse(
    TrackedPullRequestQuerySchema.safeParse({
      ...base,
      headSha: "A".repeat(40),
    })
      .success,
    "an uppercase SHA",
  );
  assertFalse(
    TrackedPullRequestQuerySchema.safeParse({ ...base, number: 0 }).success,
  );
});
