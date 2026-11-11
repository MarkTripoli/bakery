import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import type { GitHubAppClient } from "../../../apps/server/src/modules/integrations/github-app.ts";
import type { InstallationTokenBroker } from "../../../apps/server/src/modules/integrations/token-broker.ts";
import {
  createTicketFactIndex,
  createTicketSourceReader,
  readIssueRouteTarget,
  TICKET_EVENT_PAGE_LIMIT,
  TICKET_FACT_INDEX_MAX_LIMIT,
  TICKET_PULL_PAGE_LIMIT,
  TICKET_READ_PERMISSIONS,
} from "../../../apps/server/src/modules/integrations/ticket-reads.ts";
import {
  type RemoteFact,
  upsertFact,
} from "../../../apps/server/src/modules/integrations/remote-facts.ts";
import {
  evaluateReadiness,
  type ReadinessInput,
} from "../../../apps/server/src/modules/work/ticket-readiness.ts";
import type {
  IssueRef,
  TicketIssueRead,
  TicketLinksRead,
  TicketReadFailure,
  TicketSourceHandle,
} from "../../../apps/server/src/modules/work/ticket-source-reader.ts";
import { defaultTicketSourcePolicy } from "../../../packages/contracts/src/ticket-admission.ts";
import {
  fakeCommitSha,
  type FakeIssue,
  type FakeIssueEventSeed,
  type FakeIssueSeed,
  type FakeReadRoute,
  fakeTimestamp,
} from "../fake-github-app.ts";
import { openGitHubAppFixture } from "../github-app-registration.ts";
import {
  enabledReceiver,
  issuesPayload,
  receipt,
  type Receiver,
  routeRows,
} from "../github-intake/receipts-shared.ts";

/*
 * Issue 82 live reader on real Postgres and the fake GitHub: the authority
 * rows the reader loads, the narrowed token, label provenance, the
 * predecessor proof, the route target lookup and the fact index. The provider
 * lane has no database, so these cases live in the integration lane. Fixtures
 * and the fake are not live GitHub proof.
 */

const signal = () => new AbortController().signal;

const T0 = Date.parse("2026-10-30T10:00:00Z");
/** GitHub's second-resolution time, `minutes` after the fixed base. */
const at = (minutes: number) => fakeTimestamp(T0 + minutes * 60_000);
/** The canonical ISO time the reader reports for `at(minutes)`. */
const isoAt = (minutes: number) =>
  new Date(T0 + minutes * 60_000).toISOString();

const unavailable = (
  reason: TicketReadFailure["reason"],
  retryAfterSeconds: number | null = null,
): TicketReadFailure => ({ kind: "unavailable", reason, retryAfterSeconds });

/** A source: an enabled connection with one selected repository and the live reader over it. */
async function openSource(options: { requestTimeoutMs?: number } = {}) {
  const f = await openGitHubAppFixture(options);
  try {
    const r = await enabledReceiver(f);
    const handle: TicketSourceHandle = {
      organizationId: r.resource.organization_id,
      connectionId: r.connection.connectionId,
      resourceId: r.resource.id,
      repositoryFullName: r.resource.display_name,
      externalRepositoryId: r.resource.external_id,
    };
    const readerWith = (
      github: GitHubAppClient = f.github.client,
      broker: InstallationTokenBroker = f.broker,
    ) =>
      createTicketSourceReader({
        database: f.runtimePgDatabase!,
        github,
        secretsKey: f.secretsKey,
        broker,
      });
    return {
      f,
      r,
      handle,
      repositoryId: r.repositoryId,
      fullName: r.resource.display_name,
      reader: readerWith(),
      readerWith,
    };
  } catch (error) {
    await f.finish();
    throw error;
  }
}
type Source = Awaited<ReturnType<typeof openSource>>;

async function withSource(
  run: (source: Source) => Promise<void>,
  options: { requestTimeoutMs?: number } = {},
): Promise<void> {
  const source = await openSource(options);
  try {
    await run(source);
  } finally {
    await source.f.finish();
  }
}

/** Seeds issue items of the source repository and returns them. */
function seedIssues(s: Source, ...seeds: FakeIssueSeed[]): FakeIssue[] {
  return s.f.github.seedIssues(s.repositoryId, seeds);
}

function seedEvent(s: Source, number: number, seed: FakeIssueEventSeed) {
  return s.f.github.seedIssueEvent(s.repositoryId, number, seed);
}

/** Requests that reached the fake's repository reads and whose URL holds `fragment`. */
function readCalls(s: Source, fragment: string): number {
  return s.f.github.repositoryReadCalls().filter((call) =>
    call.url.includes(fragment)
  ).length;
}

/** Requests for the single issue `number` of the source repository, not its sub-resources. */
function issueReads(s: Source, number: number): number {
  const path = `/repos/${s.fullName}/issues/${number}`;
  return s.f.github.repositoryReadCalls().filter((call) =>
    new URL(call.url).pathname === path
  ).length;
}

/** The blocker reference a proof read asks about. */
const refOf = (
  s: Source,
  issue: FakeIssue,
  repositoryFullName = s.fullName,
): IssueRef => ({
  id: String(issue.id),
  number: issue.number,
  repositoryFullName,
});

/** A GitHub client whose issue reads report `patch` over the real answer. */
function withDetail(
  s: Source,
  patch: {
    subIssuesTotal?: number | null;
    blockedByTotal?: number | null;
    blockingTotal?: number | null;
  },
): GitHubAppClient {
  const client = s.f.github.client;
  return {
    ...client,
    readIssueDetail: async (request, abort) => {
      const detail = await client.readIssueDetail(request, abort);
      return detail.kind === "issue" || detail.kind === "pull_request"
        ? { ...detail, ...patch }
        : detail;
    },
  };
}

/**
 * A GitHub client whose repository identity read reports `id` as the numeric
 * id of the repository, and counts the reads, over the real answer.
 */
function withIdentityId(
  s: Source,
  id: number,
): { client: GitHubAppClient; identityReads: () => number } {
  const client = s.f.github.client;
  let reads = 0;
  return {
    client: {
      ...client,
      readRepositoryIdentity: async (request, abort) => {
        reads++;
        const identity = await client.readRepositoryIdentity(request, abort);
        return identity.kind === "present" ? { ...identity, id } : identity;
      },
    },
    identityReads: () => reads,
  };
}

// ---------------------------------------------------------------- readIssue

Deno.test("issue 82 reader: readIssue returns the bounded snapshot and calls the repository public only when GitHub says so", async () => {
  await withSource(async (s) => {
    const [issue] = seedIssues(s, {
      number: 1,
      labels: ["ready for agent", "bug"],
      updatedAt: at(0),
    });
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      title: "Add retry",
      body: "## Acceptance criteria\n- [ ] retries",
      repositoryPrivate: false,
    });
    const expected = {
      externalId: String(issue.id),
      number: 1,
      title: "Add retry",
      body: "## Acceptance criteria\n- [ ] retries",
      bodyTooLarge: false,
      labels: ["ready for agent", "bug"],
      state: "open" as const,
      stateReason: null,
      locked: false,
      repositoryFullName: s.fullName,
    };
    assertEquals(await s.reader.readIssue(s.handle, 1, signal()), {
      kind: "present",
      snapshot: expected,
      providerUpdatedAt: isoAt(0),
      visibility: "public",
    });

    // Private when GitHub says private, and also when it says nothing: unknown
    // is never read as public.
    s.f.github.seedIssueDetail(s.repositoryId, 1, { repositoryPrivate: true });
    const privateRead = await s.reader.readIssue(s.handle, 1, signal());
    assert(privateRead.kind === "present");
    assertEquals(privateRead.visibility, "private");
    s.f.github.seedIssueDetail(s.repositoryId, 1, { repositoryPrivate: null });
    const unknownRead = await s.reader.readIssue(s.handle, 1, signal());
    assert(unknownRead.kind === "present");
    assertEquals(unknownRead.visibility, "private");

    // A closed issue keeps its reason; a lock is reported.
    seedIssues(s, {
      number: 2,
      state: "closed",
      stateReason: "not_planned",
      locked: true,
      updatedAt: at(1),
    });
    const closed = await s.reader.readIssue(s.handle, 2, signal());
    assert(closed.kind === "present");
    assertEquals(
      [
        closed.snapshot.state,
        closed.snapshot.stateReason,
        closed.snapshot.locked,
      ],
      ["closed", "not_planned", true],
    );
  });
});

Deno.test("issue 82 reader: an oversized body is reported and kept as no text", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      body: "a".repeat(65_537),
    });
    const read = await s.reader.readIssue(s.handle, 1, signal());
    assert(read.kind === "present");
    assertEquals([read.snapshot.bodyTooLarge, read.snapshot.body], [true, ""]);

    // 65,536 code points are kept whole, in multi-byte text too.
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      body: "\u{1F600}".repeat(65_536),
    });
    const whole = await s.reader.readIssue(s.handle, 1, signal());
    assert(whole.kind === "present");
    assertEquals(whole.snapshot.bodyTooLarge, false);
    assertEquals([...whole.snapshot.body].length, 65_536);
  });
});

/** `[status, reason]` of the check `id` in `report`, or null when it has none. */
function outcomeOf(
  report: Awaited<ReturnType<typeof evaluateReadiness>>,
  id: string,
): [string, string] | null {
  const check = report.checks.find((entry) => entry.id === id);
  return check === undefined ? null : [check.status, check.reason];
}

/**
 * A manual start request on `issue` under the default policy: nothing but the
 * issue read can fail, unless the caller passes the `links` the reader gave
 * (by default a complete answer with no parent, sub-issue or blocker).
 */
function manualStartInput(
  issue: TicketIssueRead,
  repositoryFullName: string,
  links: TicketLinksRead = {
    kind: "present",
    parent: null,
    subIssuesTotal: 0,
    blockedBy: [],
    blockingTotal: 0,
    truncated: false,
  },
): ReadinessInput {
  return {
    source: {
      enabled: true,
      connectionEnabled: true,
      installationEnabled: true,
      resourceSelected: true,
      repositoryFullName,
      repositoryArchived: false,
      repositoryHasActiveProfile: true,
      presetReady: true,
    },
    policy: defaultTicketSourcePolicy(),
    policyRevision: 1,
    preset: { id: "fixed-coding", revision: 1, digest: "c".repeat(64) },
    issue,
    links,
    proofs: [],
    authority: { principalActive: true, provenance: null, actorRole: null },
    activeRequest: null,
    intent: "start",
    origin: "manual",
    labelBasis: "manual",
    pinnedRequirementsDigest: null,
  };
}

Deno.test("issue 82 reader: a label list past the bound is unavailable, so a hold label past position 50 never reads as not held", async () => {
  await withSource(async (s) => {
    const areas = (count: number) =>
      Array.from({ length: count }, (_, index) => `area-${index + 1}`);
    seedIssues(
      s,
      // Exactly the bound: every label is seen, the list is complete.
      { number: 1, labels: areas(50) },
      // The hold and execute labels sit past position 50.
      {
        number: 2,
        labels: [...areas(50), "bakery:hold", "ready for agent"],
      },
      // One label too many, the hold label among the first 50: still cut.
      { number: 3, labels: ["bakery:hold", ...areas(50)] },
    );
    for (const number of [1, 2, 3]) {
      s.f.github.seedIssueDetail(s.repositoryId, number, {
        body: "### Acceptance criteria\n- works",
      });
    }

    const complete = await s.reader.readIssue(s.handle, 1, signal());
    assert(complete.kind === "present");
    assertEquals(complete.snapshot.labels, areas(50));
    const clear = await evaluateReadiness(
      manualStartInput(complete, s.fullName),
    );
    assertEquals(
      clear.verdict,
      "ready",
      `control: 50 labels, none held; unmet: ${
        JSON.stringify(clear.checks.filter((check) => check.status !== "pass"))
      }`,
    );

    for (const number of [2, 3]) {
      const cut = await s.reader.readIssue(s.handle, number, signal());
      // Its own reason: the report must not read as a GitHub outage.
      assertEquals(cut, unavailable("labels_truncated"), `issue ${number}`);
      const report = await evaluateReadiness(
        manualStartInput(cut, s.fullName),
      );
      assertEquals(report.verdict, "waiting", `issue ${number}`);
      const notHeld = report.checks.find((check) => check.id === "not_held");
      assertEquals(
        [notHeld?.status, notHeld?.reason],
        ["wait", "provider_unavailable"],
        `issue ${number} never passes not_held`,
      );
      assertEquals(
        notHeld?.evidence,
        [{ ref: "provider:labels_truncated" }],
        `issue ${number} says why`,
      );
    }
  });
});

Deno.test("issue 82 reader: a pull request, a deleted, a missing and a transferred issue read as their own answers", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1, pullRequest: true }, { number: 2 }, {
      number: 3,
    });
    s.f.github.deleteIssue(s.repositoryId, 2);
    s.f.github.transferIssue(s.repositoryId, 3);
    assertEquals(await s.reader.readIssue(s.handle, 1, signal()), {
      kind: "pull_request",
    });
    assertEquals(await s.reader.readIssue(s.handle, 2, signal()), {
      kind: "gone",
    });
    assertEquals(await s.reader.readIssue(s.handle, 3, signal()), {
      kind: "moved",
    });
    assertEquals(await s.reader.readIssue(s.handle, 99, signal()), {
      kind: "gone",
    });
  });
});

Deno.test("issue 82 reader: a renamed repository is unavailable, not a gone or moved ticket", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    // GitHub answers the stored name with a redirect until discovery learns
    // the new one; the repository id check keeps the ticket from being "moved".
    s.f.github.renameRepository(s.repositoryId, "renamed-after-setup");
    assertEquals(
      await s.reader.readIssue(s.handle, 1, signal()),
      unavailable("provider_error"),
    );
    assertEquals(
      await s.reader.readLinks(s.handle, 1, signal()),
      unavailable("provider_error"),
    );
  });
});

Deno.test("issue 82 reader: a gone or moved issue is unavailable when the repository answers another numeric id", async () => {
  await withSource(async (s) => {
    const [live, deleted, transferred] = seedIssues(
      s,
      { number: 1 },
      { number: 2 },
      { number: 3 },
    );
    s.f.github.deleteIssue(s.repositoryId, 2);
    s.f.github.transferIssue(s.repositoryId, 3);
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      parentIssueUrl: `https://api.github.com/repos/${s.fullName}/issues/77`,
    });
    const sameId = withIdentityId(s, Number(s.handle.externalRepositoryId));
    const otherId = withIdentityId(
      s,
      Number(s.handle.externalRepositoryId) + 1,
    );

    // The repository still has the handle's numeric id: the issue is gone or
    // moved, as the plain reads say.
    const same = s.readerWith(sameId.client);
    assertEquals(await same.readIssue(s.handle, 2, signal()), { kind: "gone" });
    assertEquals(await same.readIssue(s.handle, 3, signal()), {
      kind: "moved",
    });
    assertEquals(
      await same.readPredecessorProof(s.handle, refOf(s, deleted), signal()),
      { kind: "inaccessible" },
    );
    const parentless = await same.readLinks(s.handle, 1, signal());
    assert(parentless.kind === "present");
    assertEquals(parentless.parent, null);
    assertEquals(sameId.identityReads(), 4, "each absent answer was checked");

    // Another numeric id says the name now belongs to another repository, so
    // nothing is known about the issue: the caller retries after discovery.
    const other = s.readerWith(otherId.client);
    assertEquals(
      await other.readIssue(s.handle, 2, signal()),
      unavailable("provider_error"),
      "a gone issue",
    );
    assertEquals(
      await other.readIssue(s.handle, 3, signal()),
      unavailable("provider_error"),
      "a moved issue",
    );
    assertEquals(
      await other.readLinks(s.handle, 2, signal()),
      unavailable("provider_error"),
      "the links of a gone issue",
    );
    assertEquals(
      await other.readLinks(s.handle, 3, signal()),
      unavailable("provider_error"),
      "the links of a moved issue",
    );
    assertEquals(
      await other.readLinks(s.handle, 1, signal()),
      unavailable("provider_error"),
      "a parent that is gone",
    );
    for (const blocker of [deleted, transferred]) {
      assertEquals(
        await other.readPredecessorProof(s.handle, refOf(s, blocker), signal()),
        unavailable("provider_error"),
        "a gone or moved blocker is not inaccessible",
      );
    }
    assertEquals(otherId.identityReads(), 7, "each absent answer was checked");

    // A present issue never asks which repository answered.
    assert(
      (await other.readIssue(s.handle, 1, signal())).kind === "present",
    );
    assertEquals(
      await other.readPredecessorProof(s.handle, refOf(s, live), signal()),
      { kind: "open" },
    );
    assertEquals(otherId.identityReads(), 7, "present issues need no check");
  });
});

// ---------------------------------------------------------------- readLinks

Deno.test("issue 82 reader: readLinks returns the parent with its id, the blockers, the sub-issue count and the blocking count", async () => {
  await withSource(async (s) => {
    const [, parent] = seedIssues(
      s,
      { number: 1 },
      { number: 2 },
      { number: 3 },
    );
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      parentIssueUrl: `https://api.github.com/repos/${s.fullName}/issues/2`,
      subIssuesTotal: 0,
      blockingTotal: 4,
    });
    const blockers = s.f.github.seedBlockedBy(s.repositoryId, 1, [
      { number: 3 },
      { number: 9, repositoryFullName: "elsewhere/other-repo" },
    ]);
    assertEquals(await s.reader.readLinks(s.handle, 1, signal()), {
      kind: "present",
      parent: {
        id: String(parent.id),
        number: 2,
        repositoryFullName: s.fullName,
      },
      subIssuesTotal: 0,
      blockedBy: blockers.map((blocker) => ({
        id: String(blocker.id),
        number: blocker.number,
        repositoryFullName: blocker.repositoryFullName,
      })),
      blockingTotal: 4,
      truncated: false,
    });
    // A parent in this repository is read once, by number, to learn its id.
    assertEquals(issueReads(s, 1), 1, "the issue itself");
    assertEquals(issueReads(s, 2), 1, "the parent");

    // A sub-issue count above zero is reported for the epic check.
    s.f.github.seedIssueDetail(s.repositoryId, 3, { subIssuesTotal: 3 });
    const epic = await s.reader.readLinks(s.handle, 3, signal());
    assert(epic.kind === "present");
    assertEquals([epic.subIssuesTotal, epic.truncated], [3, false]);
  });
});

Deno.test("issue 82 reader: no blockers means no blocker request, and a parent that cannot be read gives no parent", async () => {
  await withSource(async (s) => {
    // Issue 5 exists in this repository too: a parent named as issue 5 of
    // another repository must not be read as this repository's issue 5.
    seedIssues(s, { number: 1 }, { number: 2 }, { number: 5 });
    const none = await s.reader.readLinks(s.handle, 1, signal());
    assertEquals(
      none,
      {
        kind: "present",
        parent: null,
        subIssuesTotal: 0,
        blockedBy: [],
        blockingTotal: 0,
        truncated: false,
      },
    );
    assertEquals(readCalls(s, "blocked_by"), 0, "the summary said none");

    // The token reaches only this repository: a parent elsewhere is not read,
    // and its unknown id is never invented.
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      parentIssueUrl:
        "https://api.github.com/repos/elsewhere/other-repo/issues/5",
    });
    const elsewhere = await s.reader.readLinks(s.handle, 1, signal());
    assert(elsewhere.kind === "present");
    assertEquals(elsewhere.parent, null);
    assertEquals(readCalls(s, "other-repo"), 0);
    assertEquals(
      issueReads(s, 5),
      0,
      "issue 5 of this repository is not the parent in another repository",
    );
    assertEquals(issueReads(s, 1), 2, "only the issue itself was read again");

    // A parent in this repository that is gone gives no parent either.
    s.f.github.seedIssueDetail(s.repositoryId, 2, {
      parentIssueUrl: `https://api.github.com/repos/${s.fullName}/issues/77`,
    });
    const missing = await s.reader.readLinks(s.handle, 2, signal());
    assert(missing.kind === "present");
    assertEquals(missing.parent, null);
  });
});

Deno.test("issue 82 reader: a blocker list that is cut, miscounted or unreported is marked truncated", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    // More than the 50 blockers the snapshot stores.
    s.f.github.seedBlockedBy(
      s.repositoryId,
      1,
      Array.from({ length: 60 }, (_, index) => ({ number: 100 + index })),
    );
    const cut = await s.reader.readLinks(s.handle, 1, signal());
    assert(cut.kind === "present");
    assertEquals([cut.blockedBy.length, cut.truncated], [50, true]);

    // More than one page of blockers.
    s.f.github.seedBlockedBy(
      s.repositoryId,
      1,
      Array.from({ length: 101 }, (_, index) => ({ number: 100 + index })),
    );
    const paged = await s.reader.readLinks(s.handle, 1, signal());
    assert(paged.kind === "present");
    assertEquals([paged.blockedBy.length, paged.truncated], [50, true]);

    // GitHub counts blockers the list did not show.
    s.f.github.seedBlockedBy(s.repositoryId, 1, [{ number: 100 }, {
      number: 101,
    }]);
    const complete = await s.reader.readLinks(s.handle, 1, signal());
    assert(complete.kind === "present");
    assertEquals([complete.blockedBy.length, complete.truncated], [2, false]);
    const miscounted = await s.readerWith(withDetail(s, { blockedByTotal: 5 }))
      .readLinks(s.handle, 1, signal());
    assert(miscounted.kind === "present");
    assertEquals(miscounted.truncated, true);

    // No blocker count at all: the list alone cannot show a blocker the
    // installation cannot see, so a complete-looking list is not trusted.
    const uncounted = await s.readerWith(
      withDetail(s, { blockedByTotal: null }),
    )
      .readLinks(s.handle, 1, signal());
    assert(uncounted.kind === "present");
    assertEquals([uncounted.blockedBy.length, uncounted.truncated], [2, true]);
  });
});

Deno.test("issue 82 reader: an unreported blocker count is unknown, so dependencies_satisfied waits instead of passing on an empty list", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    s.f.github.seedIssueDetail(s.repositoryId, 1, {
      body: "### Acceptance criteria\n- works",
    });
    // The list shows no blocker: an open issue the installation cannot see
    // would be left out of it, and only the count could tell.
    s.f.github.seedBlockedBy(s.repositoryId, 1, []);
    const issue = await s.reader.readIssue(s.handle, 1, signal());
    assert(issue.kind === "present");
    const dependencies = (links: TicketLinksRead) =>
      evaluateReadiness(manualStartInput(issue, s.fullName, links));

    // Control: GitHub reports a count of zero, the links are complete and the
    // ticket is ready.
    const counted = await s.reader.readLinks(s.handle, 1, signal());
    assert(counted.kind === "present");
    assertEquals([counted.blockedBy, counted.truncated], [[], false]);
    const ready = await dependencies(counted);
    assertEquals(
      [ready.verdict, outcomeOf(ready, "dependencies_satisfied")],
      ["ready", ["pass", "ok"]],
    );

    // No count: unknown is never zero, whatever the list shows.
    const uncounted = await s.readerWith(
      withDetail(s, { blockedByTotal: null }),
    ).readLinks(s.handle, 1, signal());
    assert(uncounted.kind === "present");
    assertEquals([uncounted.blockedBy, uncounted.truncated], [[], true]);
    const waiting = await dependencies(uncounted);
    assertEquals(waiting.verdict, "waiting");
    assertEquals(
      outcomeOf(waiting, "dependencies_satisfied"),
      ["wait", "links_truncated"],
    );
  });
});

Deno.test("issue 82 reader: an unreported sub-issue count is unknown, not zero, and an unreported blocking count gates nothing", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    const unknownSubIssues = await s.readerWith(
      withDetail(s, { subIssuesTotal: null }),
    ).readLinks(s.handle, 1, signal());
    assert(unknownSubIssues.kind === "present");
    assertEquals(
      [unknownSubIssues.subIssuesTotal, unknownSubIssues.truncated],
      [0, true],
      "the count cannot be trusted as zero, so the answer is incomplete",
    );
    const unknownBlocking = await s.readerWith(
      withDetail(s, { blockingTotal: null }),
    ).readLinks(s.handle, 1, signal());
    assert(unknownBlocking.kind === "present");
    assertEquals(
      [unknownBlocking.blockingTotal, unknownBlocking.truncated],
      [0, false],
    );
  });
});

Deno.test("issue 82 reader: links of a deleted issue or a pull request are unavailable", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1, pullRequest: true }, { number: 2 });
    s.f.github.deleteIssue(s.repositoryId, 2);
    assertEquals(
      await s.reader.readLinks(s.handle, 1, signal()),
      unavailable("provider_error"),
    );
    assertEquals(
      await s.reader.readLinks(s.handle, 2, signal()),
      unavailable("provider_error"),
    );
  });
});

// ------------------------------------------------------ readLabelProvenance

const LABEL = "ready for agent";

Deno.test("issue 82 reader: label provenance sorts events locally, so the latest applier wins whatever order GitHub lists", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    // Listed newest first: GitHub documents no order.
    seedEvent(s, 1, {
      event: "labeled",
      label: LABEL,
      actor: { id: 22, login: "bob" },
      createdAt: at(3),
    });
    seedEvent(s, 1, {
      event: "unlabeled",
      label: LABEL,
      actor: { id: 11, login: "alice" },
      createdAt: at(2),
    });
    seedEvent(s, 1, {
      event: "labeled",
      label: LABEL,
      actor: { id: 11, login: "alice" },
      createdAt: at(1),
    });
    assertEquals(
      await s.reader.readLabelProvenance(s.handle, 1, LABEL, signal()),
      {
        kind: "applied",
        actorId: "22",
        actorLogin: "bob",
        appliedAt: isoAt(3),
      },
    );

    // Events in the same second are ordered by id.
    seedIssues(s, { number: 2 });
    seedEvent(s, 2, {
      id: 900,
      event: "labeled",
      label: LABEL,
      actor: { id: 22, login: "bob" },
      createdAt: at(1),
    });
    seedEvent(s, 2, {
      id: 800,
      event: "labeled",
      label: LABEL,
      actor: { id: 11, login: "alice" },
      createdAt: at(1),
    });
    const tie = await s.reader.readLabelProvenance(
      s.handle,
      2,
      LABEL,
      signal(),
    );
    assert(tie.kind === "applied");
    assertEquals(tie.actorId, "22");
  });
});

Deno.test("issue 82 reader: a relabel after an unlabel is applied by the relabeler, and an unlabel or no event is absent", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 }, { number: 2 }, { number: 3 });
    // 1: labeled, unlabeled, labeled again by someone else.
    seedEvent(s, 1, { event: "labeled", label: LABEL, createdAt: at(1) });
    seedEvent(s, 1, { event: "unlabeled", label: LABEL, createdAt: at(2) });
    seedEvent(s, 1, {
      event: "labeled",
      label: LABEL,
      actor: { id: 33, login: "carol" },
      createdAt: at(3),
    });
    const relabeled = await s.reader.readLabelProvenance(
      s.handle,
      1,
      LABEL,
      signal(),
    );
    assertEquals(relabeled, {
      kind: "applied",
      actorId: "33",
      actorLogin: "carol",
      appliedAt: isoAt(3),
    });
    // 2: labeled then unlabeled.
    seedEvent(s, 2, { event: "labeled", label: LABEL, createdAt: at(1) });
    seedEvent(s, 2, { event: "unlabeled", label: LABEL, createdAt: at(2) });
    assertEquals(
      await s.reader.readLabelProvenance(s.handle, 2, LABEL, signal()),
      {
        kind: "absent",
      },
    );
    // 3: no events for this label; another label's events and a case
    // difference do not count, since policy labels match exactly.
    seedEvent(s, 3, { event: "labeled", label: "bug", createdAt: at(1) });
    seedEvent(s, 3, {
      event: "labeled",
      label: "Ready For Agent",
      createdAt: at(2),
    });
    assertEquals(
      await s.reader.readLabelProvenance(s.handle, 3, LABEL, signal()),
      {
        kind: "absent",
      },
    );
  });
});

Deno.test("issue 82 reader: a ghost applier is unverifiable only while it is the latest", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 }, { number: 2 });
    seedEvent(s, 1, {
      event: "labeled",
      label: LABEL,
      actor: { id: 11, login: "alice" },
      createdAt: at(1),
    });
    seedEvent(s, 1, {
      event: "labeled",
      label: LABEL,
      actor: null,
      createdAt: at(2),
    });
    assertEquals(
      await s.reader.readLabelProvenance(s.handle, 1, LABEL, signal()),
      {
        kind: "unverifiable",
        reason: "ghost_actor",
      },
    );
    seedEvent(s, 2, {
      event: "labeled",
      label: LABEL,
      actor: null,
      createdAt: at(1),
    });
    seedEvent(s, 2, { event: "unlabeled", label: LABEL, createdAt: at(2) });
    seedEvent(s, 2, {
      event: "labeled",
      label: LABEL,
      actor: { id: 11, login: "alice" },
      createdAt: at(3),
    });
    const real = await s.reader.readLabelProvenance(
      s.handle,
      2,
      LABEL,
      signal(),
    );
    assert(real.kind === "applied");
    assertEquals(real.actorId, "11");
  });
});

Deno.test("issue 82 reader: a page with no kept event and a next page is walked, and the page bound makes an unfinished history unverifiable", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 }, { number: 2 }, { number: 3 }, { number: 4 });
    const noise = (number: number, count: number) => {
      for (let index = 0; index < count; index++) {
        seedEvent(s, number, { event: "referenced", createdAt: at(0) });
      }
    };
    const labeled = (number: number) =>
      seedEvent(s, number, {
        event: "labeled",
        label: LABEL,
        actor: { id: 11, login: "alice" },
        createdAt: at(1),
      });
    // 1: page 1 keeps nothing yet has a next page.
    noise(1, 100);
    labeled(1);
    const walked = await s.reader.readLabelProvenance(
      s.handle,
      1,
      LABEL,
      signal(),
    );
    assert(walked.kind === "applied");
    assertEquals(readCalls(s, "/issues/1/events"), 2);

    // 2: the label sits on page 6: past the bound of five pages.
    noise(2, 500);
    labeled(2);
    assertEquals(
      await s.reader.readLabelProvenance(s.handle, 2, LABEL, signal()),
      {
        kind: "unverifiable",
        reason: "events_incomplete",
      },
    );
    assertEquals(readCalls(s, "/issues/2/events"), TICKET_EVENT_PAGE_LIMIT);

    // 3: the label is on page 1 but pages remain: a later unlabel could be
    // among them, so nothing is verified.
    labeled(3);
    noise(3, 500);
    assertEquals(
      await s.reader.readLabelProvenance(s.handle, 3, LABEL, signal()),
      {
        kind: "unverifiable",
        reason: "events_incomplete",
      },
    );

    // 4: exactly five full pages end the history: that is complete.
    labeled(4);
    noise(4, 499);
    const exact = await s.reader.readLabelProvenance(
      s.handle,
      4,
      LABEL,
      signal(),
    );
    assert(exact.kind === "applied");
    assertEquals(readCalls(s, "/issues/4/events"), TICKET_EVENT_PAGE_LIMIT);
  });
});

// ---------------------------------------------------- readPredecessorProof

Deno.test("issue 82 reader: the predecessor proof table", async () => {
  await withSource(async (s) => {
    const repo = s.repositoryId;
    const proof = (blocker: IssueRef) =>
      s.reader.readPredecessorProof(s.handle, blocker, signal());
    /** A closed-as-completed blocker whose latest close carries `commitId`. */
    const closed = (
      number: number,
      events: FakeIssueEventSeed[],
      patch: FakeIssueSeed = {},
    ) => {
      const [issue] = seedIssues(s, {
        number,
        state: "closed",
        stateReason: "completed",
        ...patch,
      });
      for (const event of events) seedEvent(s, number, event);
      return refOf(s, issue);
    };
    const closedBy = (commitId: string | null, minutes = 5) => ({
      event: "closed",
      commitId,
      createdAt: at(minutes),
      actor: { id: 5, login: "merger" },
    });

    // open
    const [open] = seedIssues(s, { number: 2 });
    assertEquals(await proof(refOf(s, open)), { kind: "open" });

    // closed not_planned, and closed with no reason
    const [notPlanned, noReason] = seedIssues(
      s,
      { number: 3, state: "closed", stateReason: "not_planned" },
      { number: 4, state: "closed", stateReason: null },
    );
    assertEquals(await proof(refOf(s, notPlanned)), {
      kind: "closed_unmerged",
      stateReason: "not_planned",
    });
    assertEquals(await proof(refOf(s, noReason)), {
      kind: "closed_unmerged",
      stateReason: null,
    });

    // closed completed by no commit, and with no close event at all
    assertEquals(await proof(closed(5, [closedBy(null)])), {
      kind: "closed_unmerged",
      stateReason: "completed",
    });
    assertEquals(await proof(closed(6, [])), {
      kind: "proof_unavailable",
      detail: "closing_event_missing",
    });

    // closed completed by a commit that belongs to no pull request, or to an open one
    const orphan = fakeCommitSha();
    assertEquals(await proof(closed(7, [closedBy(orphan)])), {
      kind: "closed_unmerged",
      stateReason: "completed",
    });
    const openPull = fakeCommitSha();
    s.f.github.seedCommitPull(repo, openPull, { number: 50 });
    assertEquals(await proof(closed(8, [closedBy(openPull)])), {
      kind: "closed_unmerged",
      stateReason: "completed",
    });

    // merged into the default branch
    const merged = fakeCommitSha();
    s.f.github.seedCommitPull(repo, merged, {
      number: 31,
      mergedAt: at(4),
      baseRef: "main",
      mergeCommitSha: merged,
    });
    assertEquals(await proof(closed(9, [closedBy(merged)])), {
      kind: "satisfied",
      pullRequestNumber: 31,
      mergeSha: merged,
      mergedAt: isoAt(4),
    });

    // merged into another branch
    const release = fakeCommitSha();
    s.f.github.seedCommitPull(repo, release, {
      number: 32,
      mergedAt: at(4),
      baseRef: "release",
    });
    assertEquals(await proof(closed(10, [closedBy(release)])), {
      kind: "closed_unmerged",
      stateReason: "completed",
    });

    // several pull requests: the earliest merge into the default branch
    const several = fakeCommitSha();
    s.f.github.seedCommitPull(repo, several, {
      number: 40,
      mergedAt: at(4),
      baseRef: "main",
      mergeCommitSha: several,
    });
    s.f.github.seedCommitPull(repo, several, {
      number: 41,
      mergedAt: at(3),
      baseRef: "main",
      mergeCommitSha: several,
    });
    s.f.github.seedCommitPull(repo, several, {
      number: 42,
      mergedAt: at(1),
      baseRef: "release",
    });
    const picked = await proof(closed(11, [closedBy(several)]));
    assert(picked.kind === "satisfied");
    assertEquals(picked.pullRequestNumber, 41);

    // the latest close decides, listed in any order
    const later = fakeCommitSha();
    assertEquals(
      await proof(closed(12, [closedBy(later, 3), closedBy(merged, 1)])),
      { kind: "closed_unmerged", stateReason: "completed" },
      "reopened and closed again by a commit with no merged pull request",
    );
    const earlierOrphan = fakeCommitSha();
    const reclosed = await proof(
      closed(13, [closedBy(merged, 3), closedBy(earlierOrphan, 1)]),
    );
    assert(reclosed.kind === "satisfied");
  });
});

Deno.test("issue 82 reader: a close sitting past the first event page is still found", async () => {
  await withSource(async (s) => {
    const sha = fakeCommitSha();
    s.f.github.seedCommitPull(s.repositoryId, sha, {
      number: 60,
      mergedAt: at(2),
      mergeCommitSha: sha,
    });
    const [pastPageOne, pastTheBound] = seedIssues(
      s,
      { number: 1, state: "closed", stateReason: "completed" },
      { number: 2, state: "closed", stateReason: "completed" },
    );
    for (const number of [1, 2]) {
      const noise = number === 1 ? 100 : 500;
      for (let index = 0; index < noise; index++) {
        seedEvent(s, number, { event: "referenced", createdAt: at(0) });
      }
      seedEvent(s, number, {
        event: "closed",
        commitId: sha,
        createdAt: at(3),
        actor: { id: 5, login: "merger" },
      });
    }
    const found = await s.reader.readPredecessorProof(
      s.handle,
      refOf(s, pastPageOne),
      signal(),
    );
    assert(found.kind === "satisfied");
    assertEquals(readCalls(s, "/issues/1/events"), 2);
    // Pages remain after the bound: the latest close cannot be known.
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        refOf(s, pastTheBound),
        signal(),
      ),
      { kind: "proof_unavailable", detail: "events_incomplete" },
    );
  });
});

Deno.test("issue 82 reader: the closing commit's pull requests are walked to the page bound", async () => {
  await withSource(async (s) => {
    const repo = s.repositoryId;
    const openPulls = (sha: string, count: number) => {
      for (let index = 0; index < count; index++) {
        s.f.github.seedCommitPull(repo, sha, { number: 1000 + index });
      }
    };
    const mergedPull = (sha: string) =>
      s.f.github.seedCommitPull(repo, sha, {
        number: 9000,
        mergedAt: at(2),
        mergeCommitSha: sha,
      });
    const blockers = seedIssues(
      s,
      { number: 1, state: "closed", stateReason: "completed" },
      { number: 2, state: "closed", stateReason: "completed" },
      { number: 3, state: "closed", stateReason: "completed" },
    );
    const shas = blockers.map(() => fakeCommitSha());
    blockers.forEach((blocker, index) =>
      seedEvent(s, blocker.number, {
        event: "closed",
        commitId: shas[index],
        createdAt: at(3),
        actor: { id: 5, login: "merger" },
      })
    );
    // 1: the merged pull request is the 101st: page 2.
    openPulls(shas[0], 100);
    mergedPull(shas[0]);
    const second = await s.reader.readPredecessorProof(
      s.handle,
      refOf(s, blockers[0]),
      signal(),
    );
    assert(second.kind === "satisfied");
    // 2: the 500th: the last page the bound reads.
    openPulls(shas[1], 499);
    mergedPull(shas[1]);
    const last = await s.reader.readPredecessorProof(
      s.handle,
      refOf(s, blockers[1]),
      signal(),
    );
    assert(last.kind === "satisfied");
    // 3: the 501st sits past the bound and nothing else proves the merge.
    openPulls(shas[2], 500);
    mergedPull(shas[2]);
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        refOf(s, blockers[2]),
        signal(),
      ),
      { kind: "proof_unavailable", detail: "pull_requests_incomplete" },
    );
    assertEquals(
      readCalls(s, `/commits/${shas[2]}/pulls`),
      TICKET_PULL_PAGE_LIMIT,
    );
  });
});

Deno.test("issue 82 reader: a blocker in another repository is inaccessible with no repository read, and a gone, moved or changed blocker is not proof", async () => {
  await withSource(async (s) => {
    // Another repository: the narrowed token cannot read it.
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        { id: "123", number: 5, repositoryFullName: "elsewhere/other-repo" },
        signal(),
      ),
      { kind: "inaccessible" },
    );
    assertEquals(s.f.github.repositoryReadCalls().length, 0);

    // The same name in another case is the same repository.
    const [closedIssue, deleted, transferred, pullRequest] = seedIssues(
      s,
      { number: 1, state: "closed", stateReason: "not_planned" },
      { number: 2 },
      { number: 3 },
      { number: 4, pullRequest: true },
    );
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        refOf(s, closedIssue, s.fullName.toUpperCase()),
        signal(),
      ),
      { kind: "closed_unmerged", stateReason: "not_planned" },
    );
    s.f.github.deleteIssue(s.repositoryId, 2);
    s.f.github.transferIssue(s.repositoryId, 3);
    for (const issue of [deleted, transferred]) {
      assertEquals(
        await s.reader.readPredecessorProof(
          s.handle,
          refOf(s, issue),
          signal(),
        ),
        { kind: "inaccessible" },
      );
    }
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        { id: "999", number: 55, repositoryFullName: s.fullName },
        signal(),
      ),
      { kind: "inaccessible" },
      "an unseeded number is gone",
    );
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        refOf(s, pullRequest),
        signal(),
      ),
      { kind: "proof_unavailable", detail: "blocker_not_issue" },
    );
    assertEquals(
      await s.reader.readPredecessorProof(
        s.handle,
        { ...refOf(s, closedIssue), id: "424242" },
        signal(),
      ),
      { kind: "proof_unavailable", detail: "blocker_identity_changed" },
    );
  });
});

// -------------------------------------------------------------- readActorRole

Deno.test("issue 82 reader: readActorRole returns the numeric user id and permission, absent for an unknown or impossible login", async () => {
  await withSource(async (s) => {
    s.f.github.seedCollaborator(s.repositoryId, "Alice", {
      id: 4242,
      permission: "write",
    });
    s.f.github.seedCollaborator(s.repositoryId, "reader", {
      id: 7,
      permission: "none",
    });
    assertEquals(await s.reader.readActorRole(s.handle, "Alice", signal()), {
      kind: "present",
      userId: "4242",
      permission: "write",
    });
    assertEquals(await s.reader.readActorRole(s.handle, "reader", signal()), {
      kind: "present",
      userId: "7",
      permission: "none",
    });
    assertEquals(await s.reader.readActorRole(s.handle, "nobody", signal()), {
      kind: "absent",
    });
    // A bot login cannot be a collaborator and never reaches a request path.
    const before = s.f.github.calls.length;
    for (
      const login of ["dependabot[bot]", "a/b", "", "-lead", "x".repeat(40)]
    ) {
      assertEquals(await s.reader.readActorRole(s.handle, login, signal()), {
        kind: "absent",
      }, login);
    }
    assertEquals(s.f.github.calls.length, before);
  });
});

// ----------------------------------------------------------------- listIssues

Deno.test("issue 82 reader: listIssues returns open issues only, drops pull requests, pages and honors since", async () => {
  await withSource(async (s) => {
    seedIssues(
      s,
      { number: 1, labels: ["ready for agent"], updatedAt: at(1) },
      { number: 2, updatedAt: at(2) },
      { number: 3, updatedAt: at(3), pullRequest: true },
      { number: 4, updatedAt: at(4), state: "closed" },
      { number: 5, updatedAt: at(5), labels: ["bug", "ready for planning"] },
    );
    assertEquals(
      await s.reader.listIssues(s.handle, { page: 1, since: null }, signal()),
      {
        kind: "present",
        numbers: [
          { number: 1, updatedAt: isoAt(1), labels: ["ready for agent"] },
          { number: 2, updatedAt: isoAt(2), labels: [] },
          {
            number: 5,
            updatedAt: isoAt(5),
            labels: ["bug", "ready for planning"],
          },
        ],
        hasNext: false,
      },
    );
    const since = await s.reader.listIssues(
      s.handle,
      { page: 1, since: at(2) },
      signal(),
    );
    assert(since.kind === "present");
    const numbers = since.numbers.map(({ number }) => number);
    assert(numbers.includes(5), "newer than since");
    assert(!numbers.includes(1), "older than since");
  });
  await withSource(async (s) => {
    seedIssues(
      s,
      ...Array.from({ length: 55 }, (_, index) => ({
        number: index + 1,
        updatedAt: at(index),
      })),
    );
    const first = await s.reader.listIssues(
      s.handle,
      { page: 1, since: null },
      signal(),
    );
    assert(first.kind === "present");
    assertEquals([first.numbers.length, first.hasNext], [50, true]);
    const second = await s.reader.listIssues(
      s.handle,
      { page: 2, since: null },
      signal(),
    );
    assert(second.kind === "present");
    assertEquals([second.numbers.length, second.hasNext], [5, false]);
    // A page that cannot exist is the provider's refusal, not a throw.
    assertEquals(
      await s.reader.listIssues(s.handle, { page: 0, since: null }, signal()),
      unavailable("provider_error"),
    );
  });
});

// -------------------------------------------------------------- unavailable

type ReadCase = {
  name: string;
  route: FakeReadRoute;
  call: (s: Source) => Promise<unknown>;
};

const READ_CASES: ReadCase[] = [
  {
    name: "readIssue",
    route: "issue",
    call: (s) => s.reader.readIssue(s.handle, 1, signal()),
  },
  {
    name: "readLinks",
    route: "issue",
    call: (s) => s.reader.readLinks(s.handle, 1, signal()),
  },
  {
    name: "readPredecessorProof",
    route: "issue",
    call: (s) =>
      s.reader.readPredecessorProof(
        s.handle,
        { id: "1", number: 2, repositoryFullName: s.fullName },
        signal(),
      ),
  },
  {
    name: "readLabelProvenance",
    route: "issue-events",
    call: (s) => s.reader.readLabelProvenance(s.handle, 1, LABEL, signal()),
  },
  {
    name: "readActorRole",
    route: "collaborator-permission",
    call: (s) => s.reader.readActorRole(s.handle, "alice", signal()),
  },
  {
    name: "listIssues",
    route: "issues",
    call: (s) =>
      s.reader.listIssues(s.handle, { page: 1, since: null }, signal()),
  },
];

Deno.test("issue 82 reader: a provider failure on any read is an unavailable answer with the reason and wait GitHub gave", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 }, { number: 2 });
    const scripts = [
      { script: "forbidden", reason: "forbidden" },
      { script: "unauthorized", reason: "forbidden" },
      { script: "server_error", reason: "provider_error" },
    ] as const;
    for (const { script, reason } of scripts) {
      for (const read of READ_CASES) {
        s.f.github.failNext(read.route, script);
        assertEquals(
          await read.call(s),
          unavailable(reason),
          `${read.name} under ${script}`,
        );
      }
    }
    // A primary rate limit names the wait through its reset header; a
    // secondary limit names it through retry-after.
    for (const read of READ_CASES) {
      s.f.github.failNext(read.route, "rate_limited");
      const limited = await read.call(s) as TicketReadFailure;
      assertEquals(limited.kind, "unavailable", read.name);
      assertEquals(limited.reason, "rate_limited", read.name);
      assert(
        limited.retryAfterSeconds !== null &&
          limited.retryAfterSeconds >= 100 && limited.retryAfterSeconds <= 120,
        `${read.name} waited ${limited.retryAfterSeconds}`,
      );
      s.f.github.failNext(read.route, "quota");
      assertEquals(
        await read.call(s),
        unavailable("rate_limited", 30),
        `${read.name} under a secondary limit`,
      );
    }
    // Nothing failed stays failed: the next read is a plain success.
    const again = await s.reader.readIssue(s.handle, 1, signal());
    assertEquals(again.kind, "present");
  });
});

Deno.test("issue 82 reader: a failure in the middle of a proof is unavailable, never a pass", async () => {
  await withSource(async (s) => {
    const sha = fakeCommitSha();
    s.f.github.seedCommitPull(s.repositoryId, sha, {
      number: 70,
      mergedAt: at(2),
      mergeCommitSha: sha,
    });
    const [blocker] = seedIssues(s, {
      number: 1,
      state: "closed",
      stateReason: "completed",
    });
    seedEvent(s, 1, {
      event: "closed",
      commitId: sha,
      createdAt: at(3),
      actor: { id: 5, login: "merger" },
    });
    const ref = refOf(s, blocker);
    const proof = () => s.reader.readPredecessorProof(s.handle, ref, signal());
    assertEquals((await proof()).kind, "satisfied");
    s.f.github.failNext("issue-events", "rate_limited");
    assertEquals((await proof() as TicketReadFailure).reason, "rate_limited");
    s.f.github.failNext("repository", "forbidden");
    assertEquals(await proof(), unavailable("forbidden"));
    s.f.github.failNext("commit-pulls", "server_error");
    assertEquals(await proof(), unavailable("provider_error"));
    assertEquals((await proof()).kind, "satisfied");
  });
});

Deno.test("issue 82 reader: a request GitHub never answers is a timeout, and an aborted signal propagates", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    s.f.github.failNext("issue", "hang");
    assertEquals(
      await s.reader.readIssue(s.handle, 1, signal()),
      unavailable("timeout"),
    );
    const aborted = new AbortController();
    aborted.abort();
    await assertRejects(() => s.reader.readIssue(s.handle, 1, aborted.signal));
  }, { requestTimeoutMs: 150 });
});

Deno.test("issue 82 reader: a token GitHub rejects is dropped so the next read mints afresh", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    assertEquals(
      (await s.reader.readIssue(s.handle, 1, signal())).kind,
      "present",
    );
    assertEquals(s.f.github.tokenRequests.length, 1);
    assertEquals(
      (await s.reader.readIssue(s.handle, 1, signal())).kind,
      "present",
    );
    assertEquals(s.f.github.tokenRequests.length, 1, "the token is cached");
    s.f.github.failNext("issue", "unauthorized");
    assertEquals(
      await s.reader.readIssue(s.handle, 1, signal()),
      unavailable("forbidden"),
    );
    assertEquals(
      (await s.reader.readIssue(s.handle, 1, signal())).kind,
      "present",
    );
    assertEquals(s.f.github.tokenRequests.length, 2, "minted afresh");
  });
});

// ------------------------------------------------------------ token narrowing

Deno.test("issue 82 reader: every read uses one token narrowed to the repository with exactly metadata, issues and pull requests read", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    s.f.github.seedCollaborator(s.repositoryId, "alice", {
      id: 1,
      permission: "write",
    });
    assertEquals({ ...TICKET_READ_PERMISSIONS }, {
      metadata: "read",
      issues: "read",
      pull_requests: "read",
    });
    await s.reader.readIssue(s.handle, 1, signal());
    await s.reader.readLinks(s.handle, 1, signal());
    await s.reader.readLabelProvenance(s.handle, 1, LABEL, signal());
    await s.reader.readActorRole(s.handle, "alice", signal());
    await s.reader.listIssues(s.handle, { page: 1, since: null }, signal());
    await s.reader.readPredecessorProof(
      s.handle,
      { id: "9", number: 9, repositoryFullName: "elsewhere/other-repo" },
      signal(),
    );
    assertEquals(s.f.github.tokenRequests.length, 1, "one cached token");
    assertEquals(s.f.github.tokenRequests[0].repositoryIds, [s.repositoryId]);
    assertEquals(s.f.github.tokenRequests[0].permissions, {
      metadata: "read",
      issues: "read",
      pull_requests: "read",
    });
    assert(s.f.github.repositoryReadCalls().length > 0);
    // The token never rides in a recorded URL.
    for (const call of s.f.github.calls) {
      assert(!call.url.includes("ghs_"), call.url);
    }
  });
});

// ------------------------------------------------------------- authority loss

Deno.test("issue 82 reader: a source that lost its authority makes no provider call and mints no token", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    // A read first, so a cached token exists: it must not be reused either.
    assertEquals(
      (await s.reader.readIssue(s.handle, 1, signal())).kind,
      "present",
    );
    const change = (sql: string, id: string) => s.f.pgDatabase.query(sql, [id]);
    const cases: {
      name: string;
      break: () => Promise<unknown>;
      restore: () => Promise<unknown>;
    }[] = [
      {
        name: "installation suspended",
        break: () =>
          change(
            "update bakery.integration_installations set status = 'suspended' where id = $1",
            s.r.installationRowId,
          ),
        restore: () =>
          change(
            "update bakery.integration_installations set status = 'enabled' where id = $1",
            s.r.installationRowId,
          ),
      },
      {
        name: "installation revoked",
        break: () =>
          change(
            "update bakery.integration_installations set status = 'revoked' where id = $1",
            s.r.installationRowId,
          ),
        restore: () =>
          change(
            "update bakery.integration_installations set status = 'enabled' where id = $1",
            s.r.installationRowId,
          ),
      },
      {
        name: "connection disabled",
        break: () =>
          change(
            "update bakery.integration_connections set status = 'disabled' where id = $1",
            s.handle.connectionId,
          ),
        restore: () =>
          change(
            "update bakery.integration_connections set status = 'enabled' where id = $1",
            s.handle.connectionId,
          ),
      },
      {
        name: "connection archived",
        break: () =>
          change(
            "update bakery.integration_connections set archived_at = now() where id = $1",
            s.handle.connectionId,
          ),
        restore: () =>
          change(
            "update bakery.integration_connections set archived_at = null where id = $1",
            s.handle.connectionId,
          ),
      },
      {
        name: "resource deselected",
        break: () =>
          change(
            "update bakery.integration_resources set selected = false where id = $1",
            s.handle.resourceId,
          ),
        restore: () =>
          change(
            "update bakery.integration_resources set selected = true where id = $1",
            s.handle.resourceId,
          ),
      },
      {
        name: "resource unavailable",
        break: () =>
          change(
            "update bakery.integration_resources set available = false where id = $1",
            s.handle.resourceId,
          ),
        restore: () =>
          change(
            "update bakery.integration_resources set available = true where id = $1",
            s.handle.resourceId,
          ),
      },
      {
        name: "resource archived",
        break: () =>
          change(
            "update bakery.integration_resources set archived_at = now() where id = $1",
            s.handle.resourceId,
          ),
        restore: () =>
          change(
            "update bakery.integration_resources set archived_at = null where id = $1",
            s.handle.resourceId,
          ),
      },
    ];
    for (const scenario of cases) {
      await scenario.break();
      const calls = s.f.github.calls.length;
      const tokens = s.f.github.tokenRequests.length;
      for (const read of READ_CASES) {
        assertEquals(
          await read.call(s),
          unavailable("forbidden"),
          `${read.name}: ${scenario.name}`,
        );
      }
      assertEquals(s.f.github.calls.length, calls, scenario.name);
      assertEquals(s.f.github.tokenRequests.length, tokens, scenario.name);
      await scenario.restore();
      assertEquals(
        (await s.reader.readIssue(s.handle, 1, signal())).kind,
        "present",
        `${scenario.name} restored`,
      );
    }
  });
});

Deno.test("issue 82 reader: a handle for another repository than the resource row holds, and another organization's handle, read nothing", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    const before = s.f.github.calls.length;
    const wrongRepository = { ...s.handle, externalRepositoryId: "1" };
    assertEquals(
      await s.reader.readIssue(wrongRepository, 1, signal()),
      unavailable("forbidden"),
    );
    const wrongOrganization = {
      ...s.handle,
      organizationId: crypto.randomUUID(),
    };
    assertEquals(
      await s.reader.readIssue(wrongOrganization, 1, signal()),
      unavailable("forbidden"),
    );
    const wrongConnection = {
      ...s.handle,
      connectionId: crypto.randomUUID(),
    };
    assertEquals(
      await s.reader.readIssue(wrongConnection, 1, signal()),
      unavailable("forbidden"),
    );
    assertEquals(s.f.github.calls.length, before);
  });
});

Deno.test("issue 82 reader: an edit of the connection between the rows and the token refuses the read", async () => {
  await withSource(async (s) => {
    seedIssues(s, { number: 1 });
    // The generation is captured before the rows are read; an edit that
    // settles right after the capture moves it, so the broker refuses.
    const racing: InstallationTokenBroker = {
      ...s.f.broker,
      generation: (connectionId) => {
        const captured = s.f.broker.generation(connectionId);
        s.f.broker.beginEdit(connectionId)();
        return captured;
      },
    };
    const raced = s.readerWith(s.f.github.client, racing);
    assertEquals(
      await raced.readIssue(s.handle, 1, signal()),
      unavailable("forbidden"),
    );
    assertEquals(s.f.github.calls.length, 0);
    assertEquals(s.f.github.tokenRequests.length, 0);
    // An edit still in progress refuses too, and the read resumes after it.
    const end = s.f.broker.beginEdit(s.handle.connectionId);
    assertEquals(
      await s.reader.readIssue(s.handle, 1, signal()),
      unavailable("forbidden"),
    );
    assertEquals(s.f.github.calls.length, 0);
    end();
    assertEquals(
      (await s.reader.readIssue(s.handle, 1, signal())).kind,
      "present",
    );
  });
});

// ---------------------------------------------------------- readIssueRouteTarget

/** Runs `work` in one transaction as the application role. */
function inTransaction<T>(
  s: Source,
  work: (transaction: PgTransactionClient) => Promise<T>,
): Promise<T> {
  return withPgTransaction(s.f.runtimePgDatabase!, work);
}

Deno.test("issue 82 reader: readIssueRouteTarget names the issue of an issues route and nothing else", async () => {
  await withSource(async (s) => {
    const r: Receiver = s.r;
    const routeOf = async (
      options: Parameters<typeof receipt>[1],
    ): Promise<string> => {
      const accepted = await receipt(r, options);
      const routes = await routeRows(s.f, accepted.eventId);
      assertEquals(routes.length, 1);
      return routes[0].id;
    };
    const labeled = await routeOf({
      event: "issues",
      payload: issuesPayload(r, 7, "labeled"),
    });
    assertEquals(
      await inTransaction(s, (tx) => readIssueRouteTarget(tx, labeled)),
      {
        eventKind: "issues",
        action: "labeled",
        number: 7,
        resourceId: s.handle.resourceId,
        organizationId: s.handle.organizationId,
        connectionId: s.handle.connectionId,
        installationId: r.installationRowId,
      },
    );
    const edited = await routeOf({
      event: "issues",
      payload: issuesPayload(r, 8, "edited"),
    });
    const target = await inTransaction(
      s,
      (tx) => readIssueRouteTarget(tx, edited),
    );
    assertEquals([target?.number, target?.action], [8, "edited"]);

    // A route of another event kind, another purpose or no repository
    // resource has no issue target. An untracked pull request or a lifecycle
    // delivery never plans such a route here, so the rows are made to say it.
    const other = (sql: string, id: string) => s.f.pgDatabase.query(sql, [id]);
    const pull = await routeOf({
      event: "issues",
      payload: issuesPayload(r, 9, "edited"),
    });
    await other(
      `update bakery.inbound_events set event_kind = 'pull_request'
        where id = (select inbound_event_id from bakery.inbound_event_routes where id = $1)`,
      pull,
    );
    const lifecycle = await routeOf({
      event: "issues",
      payload: issuesPayload(r, 10, "edited"),
    });
    await other(
      "update bakery.inbound_event_routes set purpose = 'installation_reconcile' where id = $1",
      lifecycle,
    );
    const unbound = await routeOf({
      event: "issues",
      payload: issuesPayload(r, 11, "edited"),
    });
    await other(
      "update bakery.inbound_event_routes set resource_id = null where id = $1",
      unbound,
    );
    for (const route of [pull, lifecycle, unbound]) {
      assertEquals(
        await inTransaction(s, (tx) => readIssueRouteTarget(tx, route)),
        null,
        route,
      );
    }
    // A missing route, and something that is not a route id.
    for (const missing of [crypto.randomUUID(), "not-a-uuid", ""]) {
      assertEquals(
        await inTransaction(s, (tx) => readIssueRouteTarget(tx, missing)),
        null,
        missing,
      );
    }
    // A projection that names no issue gives no target.
    await s.f.pgDatabase.query(
      `update bakery.inbound_events set normalized_projection = '{"junk":1}'::jsonb
        where id = (select inbound_event_id from bakery.inbound_event_routes where id = $1)`,
      [labeled],
    );
    assertEquals(
      await inTransaction(s, (tx) => readIssueRouteTarget(tx, labeled)),
      null,
    );
  });
});

// ------------------------------------------------------------------ fact index

function issueFact(
  s: Source,
  externalId: string,
  number: number,
  updatedAt: number,
  overrides: Partial<RemoteFact> = {},
): RemoteFact {
  return {
    organizationId: s.handle.organizationId,
    resourceId: s.handle.resourceId,
    kind: "issue",
    externalId,
    number,
    headSha: null,
    state: "open",
    conclusion: null,
    providerUpdatedAt: new Date(T0 + updatedAt * 60_000),
    observedStartedAt: new Date(T0 + updatedAt * 60_000 + 5_000),
    summary: { labels: [], locked: false, stateReason: null },
    ...overrides,
  };
}

Deno.test("issue 82 reader: the fact index lists issue numbers oldest first after an exclusive marker", async () => {
  await withSource(async (s) => {
    const index = createTicketFactIndex();
    await inTransaction(s, async (tx) => {
      for (
        const fact of [
          issueFact(s, "1005", 5, 0),
          issueFact(s, "1009", 9, 1, {
            summary: { labels: ["ready for agent", "bug"], locked: false },
          }),
          issueFact(s, "1002", 2, 1),
          issueFact(s, "1004", 4, 2, { state: "closed" }),
          issueFact(s, "1007", 7, 3, { state: "gone" }),
          issueFact(s, "1001", 1, 4, { summary: {} }),
          // A check run is not an issue.
          issueFact(s, "7001", 0, 5, {
            kind: "check_run",
            number: null,
            headSha: "a".repeat(40),
            state: "completed",
            summary: { name: "ci", status: "completed" },
          }),
        ]
      ) await upsertFact(tx, fact);
    });
    const list = (afterMarker: string | null, limit = 50) =>
      inTransaction(s, (tx) =>
        index.listIssueNumbers(tx, {
          organizationId: s.handle.organizationId,
          resourceId: s.handle.resourceId,
          afterMarker,
          limit,
        }));
    const all = await list(null);
    assertEquals(all.map(({ number }) => number), [5, 2, 9, 4, 7, 1]);
    assertEquals(all[0].providerUpdatedAt, isoAt(0));
    assertEquals(all[2].labels, ["ready for agent", "bug"]);
    assertEquals(all[5].labels, [], "a summary without labels has none");
    // Exclusive: the issue updated at the marker is not returned again, and the
    // marker may be written with or without milliseconds.
    assertEquals((await list(isoAt(1))).map(({ number }) => number), [4, 7, 1]);
    assertEquals((await list(at(1))).map(({ number }) => number), [4, 7, 1]);
    assertEquals(await list(isoAt(4)), []);
    // Bounded.
    assertEquals((await list(null, 2)).map(({ number }) => number), [5, 2]);
    assertEquals((await list(null, 0)).length, 1);
    assertEquals((await list(null, -3)).length, 1);
    assertEquals((await list(null, Number.NaN)).length, 1);
    assertEquals((await list(null, 1.9)).length, 1);
    // Another resource's, another organization's and an invalid marker.
    const none = await inTransaction(s, (tx) =>
      index.listIssueNumbers(tx, {
        organizationId: crypto.randomUUID(),
        resourceId: s.handle.resourceId,
        afterMarker: null,
        limit: 10,
      }));
    assertEquals(none, []);
    const elsewhere = await inTransaction(
      s,
      (tx) =>
        index.listIssueNumbers(tx, {
          organizationId: s.handle.organizationId,
          resourceId: crypto.randomUUID(),
          afterMarker: null,
          limit: 10,
        }),
    );
    assertEquals(elsewhere, []);
    await assertRejects(() => list("yesterday-ish"));
  });
});

Deno.test("issue 82 reader: the fact index never answers more than its bound and keeps resources apart", async () => {
  await withSource(async (s) => {
    const index = createTicketFactIndex();
    await inTransaction(s, async (tx) => {
      for (
        let number = 1;
        number <= TICKET_FACT_INDEX_MAX_LIMIT + 5;
        number++
      ) {
        await upsertFact(
          tx,
          issueFact(s, String(2000 + number), number, number),
        );
      }
    });
    const page = await inTransaction(s, (tx) =>
      index.listIssueNumbers(tx, {
        organizationId: s.handle.organizationId,
        resourceId: s.handle.resourceId,
        afterMarker: null,
        limit: 1_000_000,
      }));
    assertEquals(page.length, TICKET_FACT_INDEX_MAX_LIMIT);
    assertEquals(page[0].number, 1);
    assertEquals(page.at(-1)?.number, TICKET_FACT_INDEX_MAX_LIMIT);
    // Resuming from the last marker returns the rest, oldest first.
    const rest = await inTransaction(s, (tx) =>
      index.listIssueNumbers(tx, {
        organizationId: s.handle.organizationId,
        resourceId: s.handle.resourceId,
        afterMarker: page.at(-1)!.providerUpdatedAt,
        limit: 50,
      }));
    assertEquals(
      rest.map(({ number }) => number),
      [101, 102, 103, 104, 105],
    );
  });
  await withSource(async (s) => {
    // A second selected resource's facts stay out of the first's index.
    const second = await openSecondResource(s);
    const index = createTicketFactIndex();
    await inTransaction(s, async (tx) => {
      await upsertFact(tx, issueFact(s, "3001", 1, 0));
      await upsertFact(tx, {
        ...issueFact(s, "3002", 2, 0),
        resourceId: second.id,
      });
    });
    const first = await inTransaction(s, (tx) =>
      index.listIssueNumbers(tx, {
        organizationId: s.handle.organizationId,
        resourceId: s.handle.resourceId,
        afterMarker: null,
        limit: 10,
      }));
    assertEquals(first.map(({ number }) => number), [1]);
  });
});

Deno.test("issue 82 reader: the fact index pages a group of issues updated at one instant by (marker, number), never skipping or repeating one", async () => {
  await withSource(async (s) => {
    const index = createTicketFactIndex();
    const tied = TICKET_FACT_INDEX_MAX_LIMIT + 20;
    await inTransaction(s, async (tx) => {
      for (let number = 1; number <= tied; number++) {
        await upsertFact(tx, issueFact(s, String(4000 + number), number, 0));
      }
      await upsertFact(tx, issueFact(s, "4900", 900, 1));
    });
    const page = (afterMarker: string | null, afterNumber?: number | null) =>
      inTransaction(s, (tx) =>
        index.listIssueNumbers(tx, {
          organizationId: s.handle.organizationId,
          resourceId: s.handle.resourceId,
          afterMarker,
          afterNumber,
          limit: 1_000_000,
        }));
    const first = await page(null);
    assertEquals(first.length, TICKET_FACT_INDEX_MAX_LIMIT);
    assertEquals(first.at(-1)?.number, TICKET_FACT_INDEX_MAX_LIMIT);
    // The marker alone is exclusive and would skip the rest of the group.
    assertEquals(
      (await page(first.at(-1)!.providerUpdatedAt)).map(({ number }) => number),
      [900],
    );
    // The keyset resumes inside the group, then moves on to the later issue.
    const second = await page(first.at(-1)!.providerUpdatedAt, 100);
    assertEquals(
      second.map(({ number }) => number),
      [...Array.from({ length: 20 }, (_, i) => 101 + i), 900],
    );
    assertEquals(await page(second.at(-1)!.providerUpdatedAt, 900), []);
    // A number without a marker is ignored.
    assertEquals((await page(null, 50)).length, TICKET_FACT_INDEX_MAX_LIMIT);
  });
});

/** A second selected repository resource on the source's connection. */
async function openSecondResource(s: Source): Promise<{ id: string }> {
  const found = await s.f.pgDatabase.query<{ id: string }>(
    `select id from bakery.integration_resources
      where connection_id = $1 and kind = 'repository' and id <> $2
      order by external_id::bigint limit 1`,
    [s.handle.connectionId, s.handle.resourceId],
  );
  assert(found.rows[0] !== undefined, "the fake lists several repositories");
  await s.f.pgDatabase.query(
    "update bakery.integration_resources set selected = true where id = $1",
    [found.rows[0].id],
  );
  return found.rows[0];
}
