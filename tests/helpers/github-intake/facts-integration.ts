import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { readTestDatabaseConfig } from "../../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import {
  type FactKey,
  type FactWriteResult,
  markGone,
  type RemoteFact,
  upsertFact,
} from "../../../apps/server/src/modules/integrations/remote-facts.ts";
import {
  findTrackedPullRequest,
  observePullRequest,
  type PullRequestObservation,
  type PullRequestRegistration,
  registerPullRequest,
  type RepositoryResource,
  resolveRepositoryId,
} from "../../../apps/server/src/modules/integrations/pull-requests.ts";
import {
  count,
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
  pendingConnection,
  type ResourceRow,
  secondOrganization,
} from "../github-app-registration.ts";
import {
  removeSeed,
  type SeededTask,
  type SeedOptions,
  seedTaskAndRepository,
  withSeededTask,
} from "./seed.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
/** An instant `seconds` after the fixed base time. */
const at = (seconds: number) => new Date(T0 + seconds * 1000);

/**
 * Lets the database clock move on between two transactions. A read-clock
 * column is set from `now()`, which is the start of the transaction, and the
 * driver hands it back as a millisecond Date, so two back-to-back transactions
 * could otherwise share one value and a strict `>` would be a coin flip.
 */
const letClockAdvance = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 20));

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/** Runs `work` in one transaction as the application role, as the server does. */
function inTransaction<T>(
  f: GitHubAppFixture,
  work: (transaction: PgTransactionClient) => Promise<T>,
): Promise<T> {
  return withPgTransaction(f.runtimePgDatabase!, work);
}

/** The first `selected` repository resources of a new enabled connection. */
async function selectedResources(
  f: GitHubAppFixture,
  selected: number,
): Promise<ResourceRow[]> {
  return (await enabledConnection(f, { selected })).selected;
}

function issueFact(
  resource: ResourceRow,
  overrides: Partial<RemoteFact> = {},
): RemoteFact {
  return {
    organizationId: resource.organization_id,
    resourceId: resource.id,
    kind: "issue",
    externalId: "1001",
    number: 7,
    headSha: null,
    state: "open",
    conclusion: null,
    providerUpdatedAt: at(0),
    observedStartedAt: at(5),
    summary: { labels: ["bug"], locked: false, stateReason: null },
    ...overrides,
  };
}

function keyOf(fact: RemoteFact): FactKey {
  return {
    organizationId: fact.organizationId,
    resourceId: fact.resourceId,
    kind: fact.kind,
    externalId: fact.externalId,
  };
}

type FactRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  installation_id: string;
  resource_id: string;
  kind: string;
  external_id: string;
  number: number | null;
  head_sha: string | null;
  state: string;
  conclusion: string | null;
  provider_updated_at: Date;
  observed_started_at: Date;
  observed_at: Date;
  digest: string;
  summary: Record<string, unknown>;
  version: number;
};

async function factRows(
  f: GitHubAppFixture,
  resourceId: string,
): Promise<FactRow[]> {
  return (await f.pgDatabase.query<FactRow>(
    `select * from bakery.integration_remote_facts
      where resource_id = $1 order by kind, external_id`,
    [resourceId],
  )).rows;
}

async function factRow(
  f: GitHubAppFixture,
  fact: Pick<RemoteFact, "resourceId" | "kind" | "externalId">,
): Promise<FactRow> {
  const row = (await factRows(f, fact.resourceId)).find((candidate) =>
    candidate.kind === fact.kind && candidate.external_id === fact.externalId
  );
  assert(row !== undefined, "the fact row exists");
  return row;
}

/** The whole row as text, to prove a refused write left it byte-identical. */
async function factText(
  f: GitHubAppFixture,
  fact: Pick<RemoteFact, "resourceId" | "kind" | "externalId">,
): Promise<string> {
  const result = await f.pgDatabase.query<{ row: string }>(
    `select fact::text as row from bakery.integration_remote_facts as fact
      where resource_id = $1 and kind = $2 and external_id = $3`,
    [fact.resourceId, fact.kind, fact.externalId],
  );
  assertEquals(result.rows.length, 1, "exactly one fact row");
  return result.rows[0].row;
}

/** A fact row without the two columns a later read of the same state moves. */
function withoutReadClock(row: FactRow) {
  const { observed_started_at: _started, observed_at: _observed, ...rest } =
    row;
  return rest;
}

async function storeCode(work: () => Promise<unknown>): Promise<string> {
  const error = await assertRejects(work);
  assert(error instanceof StandardError, String(error));
  return error.code;
}

Deno.test("issue 71 facts: a newer read replaces an older one, an older read after a newer one is stale, an equal read leaves the row", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const base = issueFact(resource);

    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, base)),
      "written",
    );
    const first = await factRow(f, base);
    assertEquals(first.version, 1);
    assertEquals(first.state, "open");
    // The connection and installation come from the organization's own row.
    assertEquals(first.organization_id, resource.organization_id);
    assertEquals(first.connection_id, resource.connection_id);
    assertEquals(first.installation_id, resource.installation_id);
    assertEquals(first.summary, {
      labels: ["bug"],
      locked: false,
      stateReason: null,
    });

    // Newer provider time replaces the stored fact.
    const newer = issueFact(resource, {
      state: "closed",
      providerUpdatedAt: at(60),
      observedStartedAt: at(61),
      summary: { labels: ["bug"], locked: false, stateReason: "completed" },
    });
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, newer)),
      "written",
    );
    const second = await factRow(f, base);
    assertEquals(second.version, 2);
    assertEquals(second.state, "closed");
    assertEquals(second.provider_updated_at, at(60));
    assertNotEquals(second.digest, first.digest);
    const afterNewer = await factText(f, base);

    // A delayed older read, even one that began later, does not overwrite it.
    const delayed = issueFact(resource, {
      providerUpdatedAt: at(30),
      observedStartedAt: at(500),
    });
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, delayed)),
      "stale",
    );
    assertEquals(await inTransaction(f, (tx) => upsertFact(tx, base)), "stale");
    assertEquals(await factText(f, base), afterNewer);

    // The same read again writes nothing and leaves the version.
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, newer)),
      "unchanged",
    );
    assertEquals(await factText(f, base), afterNewer);
    // The same state read later is unchanged too: only the stored read start
    // moves up to it; the version, digest, state and provider time stay.
    const reread = { ...newer, observedStartedAt: at(120) };
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, reread)),
      "unchanged",
    );
    const confirmed = await factRow(f, base);
    assertEquals(confirmed.observed_started_at, at(120));
    assertEquals(withoutReadClock(confirmed), withoutReadClock(second));

    // Within one provider second the later read start orders the two.
    const sameSecond = issueFact(resource, {
      state: "closed",
      providerUpdatedAt: at(60),
      observedStartedAt: at(130),
      summary: {
        labels: ["bug", "p1"],
        locked: false,
        stateReason: "completed",
      },
    });
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, sameSecond)),
      "written",
    );
    assertEquals((await factRow(f, base)).version, 3);
    const differs = {
      ...sameSecond,
      observedStartedAt: at(125),
      summary: { labels: ["p2"], locked: false, stateReason: "completed" },
    };
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, differs)),
      "stale",
    );
    assertEquals((await factRow(f, base)).version, 3);

    // Another kind or id is another fact; a check run takes its own columns.
    const check = issueFact(resource, {
      kind: "check_run",
      externalId: "1001",
      number: null,
      headSha: SHA_A,
      state: "completed",
      conclusion: "success",
      summary: { name: "build", status: "completed", appId: 5 },
    });
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, check)),
      "written",
    );
    assertEquals((await factRows(f, resource.id)).length, 2);
    const checkRow = await factRow(f, check);
    assertEquals(checkRow.head_sha, SHA_A);
    assertEquals(checkRow.conclusion, "success");
    assertEquals(checkRow.number, null);
    assertEquals((await factRow(f, base)).version, 3);
  });
});

Deno.test("issue 71 facts: a read that only bumps the provider time is written, and one that only starts later is unchanged", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const base = issueFact(resource);
    const upsert = (fact: RemoteFact) =>
      inTransaction(f, (tx) => upsertFact(tx, fact));
    assertEquals(await upsert(base), "written");
    const first = await factRow(f, base);
    assertEquals(first.version, 1);

    // The same projection with only a greater provider time is a new state.
    const touched = { ...base, providerUpdatedAt: at(30) };
    assertEquals(await upsert(touched), "written");
    const second = await factRow(f, base);
    assertEquals(second.provider_updated_at, at(30));
    assertEquals(second.observed_started_at, at(5));
    assertEquals(second.version, 2);
    assertNotEquals(second.digest, first.digest);
    assertEquals(second.state, first.state);
    assertEquals(second.summary, first.summary);

    // The same projection and provider time with only a later read start is
    // the same state: unchanged, the read start moves, the version does not.
    const later = { ...touched, observedStartedAt: at(40) };
    assertEquals(await upsert(later), "unchanged");
    const third = await factRow(f, base);
    assertEquals(third.observed_started_at, at(40));
    assertEquals(third.provider_updated_at, at(30));
    assertEquals(third.version, 2);
    assertEquals(third.digest, second.digest);
  });
});

Deno.test("issue 71 facts: an unchanged later read advances only the stored read start, so an earlier-started read of another state cannot overwrite it", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const base = issueFact(resource);
    const upsert = (fact: RemoteFact) =>
      inTransaction(f, (tx) => upsertFact(tx, fact));
    assertEquals(await upsert(base), "written");
    const first = await factRow(f, base);
    assertEquals(first.observed_started_at, at(5));

    // The same state, read later: unchanged; only the read clock moves.
    await letClockAdvance();
    assertEquals(
      await upsert({ ...base, observedStartedAt: at(100) }),
      "unchanged",
    );
    const confirmed = await factRow(f, base);
    assertEquals(confirmed.observed_started_at, at(100));
    assert(
      confirmed.observed_at.getTime() > first.observed_at.getTime(),
      "the confirming read moves observed_at strictly forward",
    );
    assertEquals(confirmed.version, 1, "the version is untouched");
    assertEquals(withoutReadClock(confirmed), withoutReadClock(first));

    // Another state in the same provider second, read before the confirming
    // read, is stale even though it began after the first read.
    const earlier = issueFact(resource, {
      state: "closed",
      observedStartedAt: at(50),
      summary: { labels: ["bug"], locked: false, stateReason: "completed" },
    });
    assertEquals(await upsert(earlier), "stale");
    const afterStale = await factText(f, base);
    assertEquals((await factRow(f, base)).state, "open");

    // A read of the stored state that is not later changes nothing at all.
    for (const startedAt of [at(100), at(60), at(5), at(-20)]) {
      assertEquals(
        await upsert({ ...base, observedStartedAt: startedAt }),
        "unchanged",
        `read start ${startedAt.toISOString()}`,
      );
      assertEquals(await factText(f, base), afterStale);
    }

    // A read of another state that began after the confirming read replaces.
    assertEquals(
      await upsert({ ...earlier, observedStartedAt: at(101) }),
      "written",
    );
    const replaced = await factRow(f, base);
    assertEquals([replaced.state, replaced.version], ["closed", 2]);
    assertEquals(replaced.observed_started_at, at(101));
  });
});

Deno.test("issue 71 facts: an invalid or oversized fact is refused and writes nothing", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const withBody = issueFact(resource, {
      summary: { labels: [], body: "free text" } as never,
    });
    const tooMany = issueFact(resource, {
      summary: { labels: Array.from({ length: 51 }, () => "x") },
    });
    const tooLarge = issueFact(resource, {
      summary: { labels: Array.from({ length: 50 }, () => "z".repeat(50)) },
    });
    const noNumber = issueFact(resource, { number: null });
    for (const fact of [withBody, tooMany, tooLarge, noNumber]) {
      await assertRejects(() => inTransaction(f, (tx) => upsertFact(tx, fact)));
    }
    assertEquals(await factRows(f, resource.id), []);
  });
});

/**
 * Waits until a backend of the fixture's own database is blocked by another
 * backend's lock, so a pass proves the second writer queued behind the first.
 * Other databases on the shared cluster never count. (The owner role cannot
 * read the application role's wait events, but it can read which backends are
 * blocked and in which database.)
 *
 * `finished`, when given, ends the wait early once it returns true: a caller
 * whose second writer may legitimately complete without ever queueing (a
 * store with no lock) then sees that outcome at once instead of timing out.
 */
async function waitForBlockedWriter(
  f: GitHubAppFixture,
  finished: () => boolean = () => false,
): Promise<void> {
  const waitMs = 10_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (finished()) return;
    const blocked = await count(
      f,
      `select count(*) from pg_stat_activity as activity
        where activity.datid = (
            select oid from pg_database where datname = current_database()
          )
          and activity.pid <> pg_backend_pid()
          and cardinality(pg_blocking_pids(activity.pid)) > 0`,
    );
    if (blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `no backend of this database was blocked on another backend's lock within ${waitMs} ms, so the second writer never queued behind the first`,
  );
}

/**
 * `holder` writes first and keeps its transaction open; `waiter`, started
 * after it, blocks behind it; the holder commits last-written-first, so the
 * waiter decides against what the holder committed.
 */
async function raceWriters(
  f: GitHubAppFixture,
  holder: RemoteFact,
  waiter: RemoteFact,
) {
  const wrote = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = inTransaction(f, async (tx) => {
    const result = await upsertFact(tx, holder);
    wrote.resolve();
    await release.promise;
    return result;
  });
  try {
    await Promise.race([wrote.promise, held]);
    const waiting = inTransaction(f, (tx) => upsertFact(tx, waiter));
    await waitForBlockedWriter(f);
    release.resolve();
    return { held: await held, waiting: await waiting };
  } finally {
    release.resolve();
    await held.catch(() => undefined);
  }
}

Deno.test("issue 71 facts: two concurrent writers in reverse order end at the newer observation", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const older = (externalId: string) =>
      issueFact(resource, {
        externalId,
        state: "open",
        providerUpdatedAt: at(10),
        observedStartedAt: at(11),
      });
    const newer = (externalId: string) =>
      issueFact(resource, {
        externalId,
        state: "closed",
        providerUpdatedAt: at(20),
        observedStartedAt: at(21),
        summary: { labels: ["bug"], locked: false, stateReason: "completed" },
      });

    // No row yet: the newer insert commits first, the older one started
    // earlier and arrives second.
    const inserted = await raceWriters(f, newer("2001"), older("2001"));
    assertEquals(inserted, { held: "written", waiting: "stale" });
    const first = await factRow(f, newer("2001"));
    assertEquals([first.state, first.version], ["closed", 1]);

    // A row exists: the newer update commits first, the older one waits on
    // its row lock and then sees the newer state.
    await inTransaction(f, (tx) =>
      upsertFact(tx, {
        ...older("2002"),
        providerUpdatedAt: at(5),
        observedStartedAt: at(6),
      }));
    const updated = await raceWriters(f, newer("2002"), older("2002"));
    assertEquals(updated, { held: "written", waiting: "stale" });
    const second = await factRow(f, newer("2002"));
    assertEquals([second.state, second.version], ["closed", 2]);

    // The same two writers in commit order: both write, the newer ends last.
    const ordered = await raceWriters(f, older("2003"), newer("2003"));
    assertEquals(ordered, { held: "written", waiting: "written" });
    const third = await factRow(f, newer("2003"));
    assertEquals([third.state, third.version], ["closed", 2]);

    // Two identical writers: one writes, the other finds the same state.
    const twins = await raceWriters(f, newer("2004"), newer("2004"));
    assertEquals(twins, { held: "written", waiting: "unchanged" });
    assertEquals((await factRow(f, newer("2004"))).version, 1);
  });
});

Deno.test("issue 71 facts: markGone records a missing object once, only from a later read, and a fresh read revives it", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const base = issueFact(resource, {
      providerUpdatedAt: at(10),
      observedStartedAt: at(11),
    });
    const key = keyOf(base);

    // Nothing stored: nothing is invented from a missing object.
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, key, at(50))),
      "absent",
    );
    assertEquals(await factRows(f, resource.id), []);

    await inTransaction(f, (tx) => upsertFact(tx, base));
    const open = await factRow(f, base);

    // A gone read that began before the stored observation is stale.
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, key, at(11))),
      "stale",
    );
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, key, at(2))),
      "stale",
    );
    assertEquals((await factRow(f, base)).state, "open");

    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, key, at(40))),
      "written",
    );
    const gone = await factRow(f, base);
    assertEquals(gone.state, "gone");
    assertEquals(gone.version, open.version + 1);
    assertEquals(gone.observed_started_at, at(40));
    assertEquals(gone.provider_updated_at, at(10), "the provider time stays");
    assertEquals(gone.summary, open.summary, "the last projection stays");
    assertNotEquals(gone.digest, open.digest);
    const afterGone = await factText(f, base);

    // Saying it again from the same read start, or an earlier one, changes
    // nothing.
    for (const startedAt of [at(40), at(20)]) {
      assertEquals(
        await inTransaction(f, (tx) => markGone(tx, key, startedAt)),
        "unchanged",
      );
      assertEquals(await factText(f, base), afterGone);
    }

    // Saying it again from a later read is unchanged too, but it confirms the
    // object gone: only the read clock moves up to it.
    await letClockAdvance();
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, key, at(90))),
      "unchanged",
    );
    const confirmed = await factRow(f, base);
    assertEquals(confirmed.state, "gone");
    assertEquals(confirmed.observed_started_at, at(90));
    assert(
      confirmed.observed_at.getTime() > gone.observed_at.getTime(),
      "the confirming gone read moves observed_at strictly forward",
    );
    assertEquals(confirmed.version, gone.version, "the version is untouched");
    assertEquals(withoutReadClock(confirmed), withoutReadClock(gone));
    const afterConfirmed = await factText(f, base);

    // A repeated gone read that is not later than that changes nothing.
    for (const startedAt of [at(90), at(60), at(40), at(2)]) {
      assertEquals(
        await inTransaction(f, (tx) => markGone(tx, key, startedAt)),
        "unchanged",
        `gone read start ${startedAt.toISOString()}`,
      );
      assertEquals(await factText(f, base), afterConfirmed);
    }

    // A read that began before the gone read is stale; the object stays gone,
    // even when it saw a greater provider time and began after the first gone
    // read, because a later gone read confirmed the object gone.
    const delayed = { ...base, observedStartedAt: at(30) };
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, delayed)),
      "stale",
    );
    const newerButEarlier = {
      ...base,
      providerUpdatedAt: at(35),
      observedStartedAt: at(60),
    };
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, newerButEarlier)),
      "stale",
    );
    assertEquals((await factRow(f, base)).state, "gone");
    assertEquals(await factText(f, base), afterConfirmed);

    // A fresh read that began after the last gone read revives the fact.
    const revived = { ...base, observedStartedAt: at(100) };
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, revived)),
      "written",
    );
    const back = await factRow(f, base);
    assertEquals([back.state, back.version], ["open", gone.version + 1]);

    // A key naming another organization finds nothing to mark.
    const foreign = { ...key, organizationId: crypto.randomUUID() };
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, foreign, at(500))),
      "absent",
    );
    assertEquals((await factRow(f, base)).state, "open");
  });
});

Deno.test("issue 71 facts: a gone fact is replaced only by a read that began after the gone read, whatever provider time that read saw", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const base = issueFact(resource, {
      providerUpdatedAt: at(10),
      observedStartedAt: at(11),
    });
    const upsert = (fact: RemoteFact) =>
      inTransaction(f, (tx) => upsertFact(tx, fact));
    assertEquals(await upsert(base), "written");
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, keyOf(base), at(40))),
      "written",
    );
    const gone = await factRow(f, base);
    assertEquals([gone.state, gone.version], ["gone", 2]);
    const afterGone = await factText(f, base);

    // A greater provider time with an earlier read start: the object was
    // found gone by a later read, so this older read stays stale.
    assertEquals(
      await upsert({
        ...base,
        providerUpdatedAt: at(35),
        observedStartedAt: at(30),
      }),
      "stale",
    );
    assertEquals(await factText(f, base), afterGone);
    // The same read start as the gone read is not later either.
    assertEquals(
      await upsert({
        ...base,
        providerUpdatedAt: at(35),
        observedStartedAt: at(40),
      }),
      "stale",
    );
    assertEquals(await factText(f, base), afterGone);

    // A read that began after the gone read revives the fact.
    assertEquals(
      await upsert({
        ...base,
        providerUpdatedAt: at(35),
        observedStartedAt: at(60),
      }),
      "written",
    );
    const revived = await factRow(f, base);
    assertEquals([revived.state, revived.version], ["open", 3]);
    assertEquals(revived.provider_updated_at, at(35));
    assertEquals(revived.observed_started_at, at(60));
  });
});

/** Two organizations' connections to one installation, each with resources. */
async function twoOrganizations(f: GitHubAppFixture) {
  const first = await enabledConnection(f, { selected: 2 });
  const secondId = await secondOrganization(f);
  const second = await pendingConnection(f, {
    app: first.app,
    existing: first.installation,
    attempt: { organizationId: secondId },
  });
  const counterpart = (resource: ResourceRow) =>
    second.resources.find((row) => row.external_id === resource.external_id)!;
  return { first, second, secondId, counterpart };
}

Deno.test("issue 71 stores: a second organization's rows never change and its keys reach nothing of the first", async () => {
  await withFixture(async (f) => {
    const { first, secondId, counterpart } = await twoOrganizations(f);
    const own = first.selected[0];
    const other = counterpart(own);
    assertNotEquals(own.organization_id, other.organization_id);
    assertEquals(other.organization_id, secondId);

    // Facts: org 1's fact, then every cross-organization attempt.
    const fact = issueFact(own);
    await inTransaction(f, (tx) => upsertFact(tx, fact));
    const before = await factText(f, fact);
    const crossKey = { ...fact, organizationId: other.organization_id };
    const newerOfOwn = {
      ...fact,
      state: "closed",
      providerUpdatedAt: at(900),
      observedStartedAt: at(901),
    };
    // The second organization naming the first one's resource.
    assertEquals(
      await storeCode(() =>
        inTransaction(
          f,
          (tx) =>
            upsertFact(tx, {
              ...newerOfOwn,
              organizationId: other.organization_id,
            }),
        )
      ),
      "RESOURCE_NOT_FOUND",
    );
    // The first organization naming the second one's resource.
    assertEquals(
      await storeCode(() =>
        inTransaction(
          f,
          (tx) => upsertFact(tx, { ...fact, resourceId: other.id }),
        )
      ),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(
      await inTransaction(f, (tx) => markGone(tx, keyOf(crossKey), at(950))),
      "absent",
    );
    assertEquals(await factText(f, fact), before);
    assertEquals(await factRows(f, other.id), []);

    // The second organization writes its own row for the same repository.
    const theirs = issueFact(other, { state: "closed" });
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, theirs)),
      "written",
    );
    const theirRow = await factRow(f, theirs);
    assertEquals(theirRow.organization_id, other.organization_id);
    assertEquals(theirRow.connection_id, other.connection_id);
    assertNotEquals(theirRow.connection_id, own.connection_id);
    assertEquals(await factText(f, fact), before);
    const theirText = await factText(f, theirs);
    // A newer read of the first organization's fact leaves the second's.
    assertEquals(
      await inTransaction(f, (tx) => upsertFact(tx, newerOfOwn)),
      "written",
    );
    assertEquals(await factText(f, theirs), theirText);

    // Pull requests: the second organization sees and changes nothing of
    // the first one's tracked pull request.
    await withSeededTask(f, own, {}, async (seed) => {
      await withSeededTask(f, other, {}, async (foreignSeed) => {
        const registration: PullRequestRegistration = {
          organizationId: own.organization_id,
          taskId: seed.taskId,
          repositoryId: seed.repositoryId,
          providerNumber: 5,
          url: "https://github.com/o/r/pull/5",
          headSha: SHA_A,
          baseSha: SHA_B,
        };
        await inTransaction(f, (tx) => registerPullRequest(tx, registration));
        const prBefore = await pullRequestText(f, seed.repositoryId, 5);
        assertEquals(
          await inTransaction(f, (tx) =>
            findTrackedPullRequest(tx, {
              organizationId: secondId,
              repositoryId: seed.repositoryId,
              number: 5,
            })),
          null,
        );
        assertEquals(
          await storeCode(() =>
            inTransaction(f, (tx) =>
              observePullRequest(
                tx,
                seed.repositoryId,
                observation({ organizationId: secondId }),
              ))
          ),
          "RESOURCE_NOT_FOUND",
        );
        // Registering the taken pair under the second organization is not found.
        assertEquals(
          await storeCode(() =>
            inTransaction(f, (tx) =>
              registerPullRequest(tx, {
                ...registration,
                organizationId: secondId,
                taskId: foreignSeed.taskId,
              }))
          ),
          "RESOURCE_NOT_FOUND",
        );
        // A free pair across organizations is refused by the composite keys.
        await assertRejects(() =>
          inTransaction(f, (tx) =>
            registerPullRequest(tx, {
              ...registration,
              organizationId: secondId,
              providerNumber: 6,
            }))
        );
        assertEquals(await pullRequestText(f, seed.repositoryId, 5), prBefore);
        assertEquals(
          await count(
            f,
            "select count(*) from bakery.pull_requests where repository_id = any($1::uuid[])",
            [[seed.repositoryId, foreignSeed.repositoryId]],
          ),
          1,
        );
      });
    });
  });
});

Deno.test("issue 71 facts: upsertFact refuses an archived resource or one that is not a repository, as it does a foreign organization's", async () => {
  await withFixture(async (f) => {
    const [archived, notRepository, neverStored] = await selectedResources(
      f,
      3,
    );
    const upsert = (fact: RemoteFact) =>
      inTransaction(f, (tx) => upsertFact(tx, fact));
    const archive =
      "update bakery.integration_resources set archived_at = now() where id = $1";
    const retire =
      "update bakery.integration_resources set kind = 'organization' where id = $1";

    for (
      const [label, resource, change] of [
        ["archived", archived, archive],
        ["not a repository", notRepository, retire],
      ] as const
    ) {
      // A fact stored while the resource was a live repository.
      const stored = issueFact(resource);
      assertEquals(await upsert(stored), "written", label);
      await f.pgDatabase.query(change, [resource.id]);
      const before = await factText(f, stored);
      const attempts: Record<string, RemoteFact> = {
        "a newer read": {
          ...stored,
          state: "closed",
          providerUpdatedAt: at(60),
          observedStartedAt: at(61),
        },
        "an equal read": stored,
        "the stored state read later": {
          ...stored,
          observedStartedAt: at(120),
        },
        "an older read": {
          ...stored,
          state: "closed",
          providerUpdatedAt: at(-30),
          observedStartedAt: at(-29),
        },
        "another object": { ...stored, externalId: "2002" },
      };
      for (const [name, fact] of Object.entries(attempts)) {
        assertEquals(
          await storeCode(() => upsert(fact)),
          "RESOURCE_NOT_FOUND",
          `${label}: ${name}`,
        );
      }
      assertEquals(await factText(f, stored), before, label);
      assertEquals((await factRows(f, resource.id)).length, 1, label);
    }

    // No fact was ever stored for an archived resource: nothing is invented.
    await f.pgDatabase.query(archive, [neverStored.id]);
    assertEquals(
      await storeCode(() => upsert(issueFact(neverStored))),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(await factRows(f, neverStored.id), []);
  });
});

async function resolution(
  f: GitHubAppFixture,
  resource: ResourceRow,
  overrides: Partial<RepositoryResource> = {},
): Promise<string | null> {
  const identity: RepositoryResource = {
    organizationId: resource.organization_id,
    connectionId: resource.connection_id,
    externalId: resource.external_id,
    displayName: resource.display_name,
    ...overrides,
  };
  return await inTransaction(f, (tx) => resolveRepositoryId(tx, identity));
}

Deno.test("issue 71 repository join: resolveRepositoryId matches by id or full name, and never by an archived, ambiguous or foreign row", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const seeded = (
      options: SeedOptions,
      check: (seed: SeededTask) => Promise<void>,
    ) => withSeededTask(f, resource, options, check);

    // None: no Bakery repository names the GitHub repository.
    assertEquals(await resolution(f, resource), null);

    await seeded({}, async ({ repositoryId: id }) => {
      assertEquals(await resolution(f, resource), id, "by numeric id");
      // Another connection or organization never matches.
      assertEquals(
        await resolution(f, resource, { connectionId: crypto.randomUUID() }),
        null,
      );
      assertEquals(
        await resolution(f, resource, { organizationId: crypto.randomUUID() }),
        null,
      );
      // A different GitHub repository is not this one.
      assertEquals(
        await resolution(f, resource, {
          externalId: "999999999",
          displayName: "nobody/nothing",
        }),
        null,
      );
    });
    assertEquals(await resolution(f, resource), null, "the seed is removed");

    await seeded(
      { providerRepoId: "full-name" },
      async ({ repositoryId: id }) => {
        assertEquals(await resolution(f, resource), id, "by full name");
      },
    );

    await seeded({ archived: true }, async () => {
      assertEquals(await resolution(f, resource), null, "archived by id");
    });
    await seeded({ providerRepoId: "full-name", archived: true }, async () => {
      assertEquals(await resolution(f, resource), null, "archived by name");
    });

    await seeded({ competing: true }, async () => {
      assertEquals(await resolution(f, resource), null, "ambiguous");
    });
    await seeded({ competing: true, providerRepoId: "full-name" }, async () => {
      assertEquals(
        await resolution(f, resource),
        null,
        "ambiguous, name first",
      );
    });
    // An archived competitor does not make the join ambiguous.
    await seeded({ competing: true }, async (seed) => {
      await f.pgDatabase.query(
        "update bakery.repositories set archived_at = now() where id = $1",
        [seed.competingRepositoryId],
      );
      assertEquals(
        await resolution(f, resource),
        seed.repositoryId,
        "archived competitor",
      );
    });
  });
});

function observation(
  overrides: Partial<PullRequestObservation> & { organizationId: string },
): PullRequestObservation {
  return {
    number: 5,
    state: "open",
    merged: false,
    url: "https://github.com/o/r/pull/5",
    headSha: SHA_A,
    baseSha: SHA_B,
    mergedSha: null,
    providerUpdatedAt: at(0),
    observedStartedAt: at(5),
    ...overrides,
  };
}

async function pullRequestText(
  f: GitHubAppFixture,
  repositoryId: string,
  number: number,
): Promise<string> {
  const result = await f.pgDatabase.query<{ row: string }>(
    `select pr::text as row from bakery.pull_requests as pr
      where repository_id = $1 and provider_number = $2`,
    [repositoryId, number],
  );
  assertEquals(result.rows.length, 1, "exactly one pull request row");
  return result.rows[0].row;
}

type PullRequestRow = {
  id: string;
  task_id: string;
  status: string;
  head_sha: string;
  base_sha: string;
  merged_sha: string | null;
  provider_updated_at: Date | null;
  observed_started_at: Date | null;
  last_observed_at: Date | null;
  version: number;
};

async function pullRequestRow(
  f: GitHubAppFixture,
  repositoryId: string,
  number: number,
): Promise<PullRequestRow> {
  return (await f.pgDatabase.query<PullRequestRow>(
    "select * from bakery.pull_requests where repository_id = $1 and provider_number = $2",
    [repositoryId, number],
  )).rows[0];
}

Deno.test("issue 71 pull requests: registration is idempotent, lookups find tracked rows only, and observations follow the ordering rule", async () => {
  await withFixture(async (f) => {
    const resources = await selectedResources(f, 2);
    const seed = await seedTaskAndRepository(f, resources[0]);
    const other = await seedTaskAndRepository(f, resources[1]);
    try {
      const organizationId = resources[0].organization_id;
      const registration: PullRequestRegistration = {
        organizationId,
        taskId: seed.taskId,
        repositoryId: seed.repositoryId,
        providerNumber: 5,
        url: "https://github.com/o/r/pull/5",
        headSha: SHA_A,
        baseSha: SHA_B,
      };

      // Registration: created once, then the stored row comes back.
      const created = await inTransaction(
        f,
        (tx) => registerPullRequest(tx, registration),
      );
      assert(created.created);
      assertEquals(created.pullRequest.status, "open");
      assertEquals(created.pullRequest.version, 1);
      assertEquals(created.pullRequest.providerUpdatedAt, null);
      assertEquals(created.pullRequest.lastObservedAt, null);
      const again = await inTransaction(
        f,
        (tx) => registerPullRequest(tx, registration),
      );
      assertFalse(again.created);
      assertEquals(again.pullRequest, created.pullRequest);
      assertEquals(
        await count(
          f,
          "select count(*) from bakery.pull_requests where repository_id = $1",
          [seed.repositoryId],
        ),
        1,
      );
      // The same pair for another task is a conflict, never a hand-over.
      assertEquals(
        await storeCode(() =>
          inTransaction(
            f,
            (tx) =>
              registerPullRequest(tx, {
                ...registration,
                taskId: other.taskId,
              }),
          )
        ),
        "STATE_CONFLICT",
      );
      assertEquals(
        (await pullRequestRow(f, seed.repositoryId, 5)).task_id,
        seed.taskId,
      );

      // Lookups: by number, by head SHA, by either, and misses.
      const find = (
        query: { number?: number; headSha?: string; repositoryId?: string },
      ) =>
        inTransaction(f, (tx) =>
          findTrackedPullRequest(tx, {
            organizationId,
            repositoryId: query.repositoryId ?? seed.repositoryId,
            ...query,
          }));
      assertEquals((await find({ number: 5 }))?.id, created.pullRequest.id);
      assertEquals(
        (await find({ headSha: SHA_A }))?.id,
        created.pullRequest.id,
      );
      assertEquals(
        (await find({ number: 5, headSha: SHA_C }))?.id,
        created.pullRequest.id,
      );
      assertEquals(
        (await find({ number: 99, headSha: SHA_A }))?.id,
        created.pullRequest.id,
        "either key finds it",
      );
      assertEquals(await find({ number: 6 }), null);
      assertEquals(await find({ headSha: SHA_C }), null);
      assertEquals(
        await find({ number: 5, repositoryId: other.repositoryId }),
        null,
      );
      await assertRejects(() => find({}));
      // A second pull request on the same head: the number match wins.
      const second = await inTransaction(
        f,
        (tx) => registerPullRequest(tx, { ...registration, providerNumber: 6 }),
      );
      assertEquals(
        (await find({ number: 6, headSha: SHA_A }))?.id,
        second.pullRequest.id,
      );
      assertEquals(
        (await find({ number: 5, headSha: SHA_A }))?.id,
        created.pullRequest.id,
      );

      // Observation: the first read of a registered row writes, even when it
      // matches what was registered, because it sets the ordering marker.
      const open = observation({ organizationId });
      const observe = (value: PullRequestObservation) =>
        inTransaction(
          f,
          (tx) => observePullRequest(tx, seed.repositoryId, value),
        );
      assertEquals(await observe(open), "written");
      const observed = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals(observed.version, 2);
      assertEquals(observed.provider_updated_at, at(0));
      assertEquals(observed.observed_started_at, at(5));
      assert(observed.last_observed_at !== null);
      const afterOpen = await pullRequestText(f, seed.repositoryId, 5);

      // An equal read writes nothing.
      assertEquals(await observe(open), "unchanged");
      assertEquals(await pullRequestText(f, seed.repositoryId, 5), afterOpen);
      // The same state read later is unchanged: only the stored read start
      // moves up to it; the version and the state stay.
      assertEquals(
        await observe({ ...open, observedStartedAt: at(50) }),
        "unchanged",
      );
      const confirmed = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals(confirmed.observed_started_at, at(50));
      assertEquals(confirmed.version, observed.version);
      assertEquals(confirmed.provider_updated_at, at(0));
      assertEquals(confirmed.head_sha, SHA_A);
      assertEquals(confirmed.status, "open");

      // A new head from a newer read is written; the number and task stay.
      const pushed = observation({
        organizationId,
        headSha: SHA_C,
        providerUpdatedAt: at(60),
        observedStartedAt: at(61),
      });
      assertEquals(await observe(pushed), "written");
      const afterPush = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals([afterPush.head_sha, afterPush.version], [SHA_C, 3]);
      // A delayed older read, even one that began later, is stale.
      assertEquals(
        await observe({ ...open, observedStartedAt: at(900) }),
        "stale",
      );
      assertEquals(
        (await pullRequestRow(f, seed.repositoryId, 5)).head_sha,
        SHA_C,
      );

      // Closed and merged is stored as merged, with the merge commit.
      const merged = observation({
        organizationId,
        headSha: SHA_C,
        state: "closed",
        merged: true,
        mergedSha: SHA_B,
        providerUpdatedAt: at(120),
        observedStartedAt: at(121),
      });
      assertEquals(await observe(merged), "written");
      const afterMerge = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals([afterMerge.status, afterMerge.merged_sha], [
        "merged",
        SHA_B,
      ]);
      // A read of the open state that began later but is older stays stale.
      assertEquals(
        await observe({ ...pushed, observedStartedAt: at(700) }),
        "stale",
      );
      assertEquals(
        (await pullRequestRow(f, seed.repositoryId, 5)).status,
        "merged",
      );
      // Tracking continues after the merge.
      assertEquals((await find({ number: 5 }))?.status, "merged");

      // Closed without a merge keeps no merge commit, even when GitHub names one.
      assertEquals(
        await observe(observation({
          organizationId,
          number: 6,
          state: "closed",
          merged: false,
          mergedSha: SHA_B,
          providerUpdatedAt: at(10),
          observedStartedAt: at(11),
        })),
        "written",
      );
      const closed = await pullRequestRow(f, seed.repositoryId, 6);
      assertEquals([closed.status, closed.merged_sha], ["closed", null]);

      // An unregistered pull request is not adopted by being observed.
      assertEquals(
        await storeCode(() =>
          observe(observation({ organizationId, number: 77 }))
        ),
        "RESOURCE_NOT_FOUND",
      );
      assertEquals(
        await count(
          f,
          "select count(*) from bakery.pull_requests where repository_id = $1",
          [
            seed.repositoryId,
          ],
        ),
        2,
      );
    } finally {
      try {
        await removeSeed(f, seed);
      } finally {
        await removeSeed(f, other);
      }
    }
  });
});

Deno.test("issue 71 pull requests: an unchanged later read advances only the read clock, so an earlier-started read of another state cannot overwrite it", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const organizationId = resource.organization_id;
    await withSeededTask(f, resource, {}, async (seed) => {
      await inTransaction(f, (tx) =>
        registerPullRequest(tx, {
          organizationId,
          taskId: seed.taskId,
          repositoryId: seed.repositoryId,
          providerNumber: 5,
          url: "https://github.com/o/r/pull/5",
          headSha: SHA_A,
          baseSha: SHA_B,
        }));
      const observe = (value: PullRequestObservation) =>
        inTransaction(
          f,
          (tx) => observePullRequest(tx, seed.repositoryId, value),
        );
      const open = observation({ organizationId });
      assertEquals(await observe(open), "written");
      const first = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals(first.observed_started_at, at(5));

      // The same state, read later: unchanged; only the read clock moves.
      await letClockAdvance();
      assertEquals(
        await observe({ ...open, observedStartedAt: at(100) }),
        "unchanged",
      );
      const confirmed = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals(confirmed.observed_started_at, at(100));
      assert(
        confirmed.last_observed_at!.getTime() >
          first.last_observed_at!.getTime(),
        "the confirming read moves last_observed_at strictly forward",
      );
      assertEquals(
        confirmed.version,
        first.version,
        "the version is untouched",
      );
      assertEquals(
        [
          confirmed.provider_updated_at,
          confirmed.head_sha,
          confirmed.base_sha,
          confirmed.status,
          confirmed.merged_sha,
        ],
        [
          first.provider_updated_at,
          first.head_sha,
          first.base_sha,
          first.status,
          first.merged_sha,
        ],
      );

      // A new head in the same provider second, read before the confirming
      // read, is stale even though it began after the first read.
      const pushed = observation({
        organizationId,
        headSha: SHA_C,
        observedStartedAt: at(50),
      });
      assertEquals(await observe(pushed), "stale");
      const afterStale = await pullRequestText(f, seed.repositoryId, 5);
      assertEquals(
        (await pullRequestRow(f, seed.repositoryId, 5)).head_sha,
        SHA_A,
      );

      // A read of the stored state that is not later changes nothing at all.
      for (const startedAt of [at(100), at(60), at(5), at(-20)]) {
        assertEquals(
          await observe({ ...open, observedStartedAt: startedAt }),
          "unchanged",
          `read start ${startedAt.toISOString()}`,
        );
        assertEquals(
          await pullRequestText(f, seed.repositoryId, 5),
          afterStale,
        );
      }

      // A read of another state that began after the confirming read writes.
      assertEquals(
        await observe({ ...pushed, observedStartedAt: at(101) }),
        "written",
      );
      const replaced = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals([replaced.head_sha, replaced.version], [
        SHA_C,
        first.version + 1,
      ]);
    });
  });
});

type TransactionQuery = PgTransactionClient["query"];
type QueryRow = Awaited<ReturnType<TransactionQuery>>["rows"][number];

/**
 * A transaction client that runs `afterFirst` once, right after the first
 * statement sent through it completes and before the second is sent.
 */
function interposingClient(
  transaction: PgTransactionClient,
  afterFirst: () => Promise<void>,
): PgTransactionClient {
  let sent = 0;
  return {
    async query<R extends QueryRow = QueryRow>(
      queryTextOrConfig: Parameters<TransactionQuery>[0],
      values?: Parameters<TransactionQuery>[1],
    ) {
      const result = await transaction.query<R>(queryTextOrConfig, values);
      sent += 1;
      if (sent === 1) await afterFirst();
      return result;
    },
  };
}

/**
 * Observes `first` in one transaction. Right after that transaction's first
 * statement, `second` is observed on another connection, and the first
 * transaction goes on only once the second has finished or is queued behind
 * a lock. So `second` always competes with `first` from between its first and
 * its second statement: a store that does not lock the row lets `second`
 * commit there, one that does makes it wait for the first to commit.
 */
async function observeWithInterposedWriter(
  f: GitHubAppFixture,
  repositoryId: string,
  first: PullRequestObservation,
  second: PullRequestObservation,
): Promise<{ first: FactWriteResult; second: FactWriteResult }> {
  let interposed: Promise<FactWriteResult> | undefined;
  let secondFinished = false;
  try {
    const firstResult = await inTransaction(
      f,
      (transaction) =>
        observePullRequest(
          interposingClient(transaction, async () => {
            interposed = inTransaction(
              f,
              (other) => observePullRequest(other, repositoryId, second),
            );
            interposed.then(
              () => {
                secondFinished = true;
              },
              () => {
                secondFinished = true;
              },
            );
            await waitForBlockedWriter(f, () => secondFinished);
          }),
          repositoryId,
          first,
        ),
    );
    assert(interposed !== undefined, "the second writer was started");
    return { first: firstResult, second: await interposed };
  } finally {
    await interposed?.catch(() => undefined);
  }
}

Deno.test("issue 71 pull requests: a writer that commits while a read of the stored state is being confirmed cannot make the later read stale", async () => {
  await withFixture(async (f) => {
    const resource = (await selectedResources(f, 1))[0];
    const organizationId = resource.organization_id;
    await withSeededTask(f, resource, {}, async (seed) => {
      await inTransaction(f, (tx) =>
        registerPullRequest(tx, {
          organizationId,
          taskId: seed.taskId,
          repositoryId: seed.repositoryId,
          providerNumber: 5,
          url: "https://github.com/o/r/pull/5",
          headSha: SHA_A,
          baseSha: SHA_B,
        }));
      const observe = (value: PullRequestObservation) =>
        inTransaction(
          f,
          (tx) => observePullRequest(tx, seed.repositoryId, value),
        );
      const stored = observation({ organizationId, observedStartedAt: at(20) });
      assertEquals(await observe(stored), "written");
      const base = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals([base.head_sha, base.version], [SHA_A, 2]);

      // The read of the stored state began at 70 s. A writer of another head
      // in the same provider second, whose read began at 50 s, runs while that
      // read is being confirmed. The 70 s read is the latest-started one, so it
      // is unchanged, the 50 s read is stale, and the row keeps the stored
      // state with the read start moved to 70 s. Without the row lock the
      // writer commits first, the 70 s read finds a different state, is
      // reported stale, and the row ends at the 50 s head.
      await letClockAdvance();
      const earlierWriter = await observeWithInterposedWriter(
        f,
        seed.repositoryId,
        { ...stored, observedStartedAt: at(70) },
        observation({
          organizationId,
          headSha: SHA_C,
          observedStartedAt: at(50),
        }),
      );
      assertEquals(earlierWriter, { first: "unchanged", second: "stale" });
      const confirmed = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals(
        [confirmed.head_sha, confirmed.version, confirmed.observed_started_at],
        [SHA_A, base.version, at(70)],
      );
      assert(
        confirmed.last_observed_at!.getTime() >
          base.last_observed_at!.getTime(),
        "the confirmation moved last_observed_at",
      );

      // The same race with a writer whose read began after the confirmed one
      // (150 s): the confirmation still lands, and the later write is not lost.
      const laterWriter = await observeWithInterposedWriter(
        f,
        seed.repositoryId,
        { ...stored, observedStartedAt: at(120) },
        observation({
          organizationId,
          headSha: SHA_C,
          observedStartedAt: at(150),
        }),
      );
      assertEquals(laterWriter, { first: "unchanged", second: "written" });
      const final = await pullRequestRow(f, seed.repositoryId, 5);
      assertEquals(
        [final.head_sha, final.version, final.observed_started_at],
        [SHA_C, base.version + 1, at(150)],
      );
    });
  });
});

Deno.test("issue 71 cleanup: fixture teardown succeeds with facts, checkpoints, routes and receipts present", async () => {
  const f = await openGitHubAppFixture();
  let finished = false;
  const ids = {
    facts: [] as string[],
    checkpoint: crypto.randomUUID(),
    event: crypto.randomUUID(),
    orphanEvent: crypto.randomUUID(),
    route: crypto.randomUUID(),
  };
  try {
    const resource = (await selectedResources(f, 1))[0];
    await inTransaction(f, async (tx) => {
      await upsertFact(tx, issueFact(resource));
      await upsertFact(
        tx,
        issueFact(resource, {
          kind: "check_run",
          externalId: "5001",
          number: null,
          headSha: SHA_A,
          state: "completed",
          conclusion: "success",
          summary: { name: "build" },
        }),
      );
    });
    ids.facts = (await factRows(f, resource.id)).map((row) => row.id);
    assertEquals(ids.facts.length, 2);
    const registration = (await f.pgDatabase.query<{ registration_id: string }>(
      "select registration_id from bakery.integration_installations where id = $1",
      [resource.installation_id],
    )).rows[0].registration_id;
    const receipt = (id: string, installationId: string | null) =>
      f.pgDatabase.query(
        `insert into bakery.inbound_events (
           id, provider, registration_id, external_delivery_id, payload_digest,
           event_kind, event_action, installation_id, status, expires_at
         ) values ($1, 'github', $2, $3, $4, 'issues', 'opened', $5, 'routed',
           now() + interval '7 days')`,
        [id, registration, crypto.randomUUID(), "0".repeat(64), installationId],
      );
    await receipt(ids.event, resource.installation_id);
    // A receipt of an unknown installation names only the registration.
    await receipt(ids.orphanEvent, null);
    await f.pgDatabase.query(
      `insert into bakery.inbound_event_routes (
         id, inbound_event_id, organization_id, connection_id, installation_id,
         resource_id, purpose, status
       ) values ($1, $2, $3, $4, $5, $6, 'fact_refresh', 'pending')`,
      [
        ids.route,
        ids.event,
        resource.organization_id,
        resource.connection_id,
        resource.installation_id,
        resource.id,
      ],
    );
    await f.pgDatabase.query(
      `insert into bakery.integration_sync_checkpoints (
         id, organization_id, connection_id, installation_id, resource_id,
         stream, status
       ) values ($1, $2, $3, $4, $5, 'issues', 'idle')`,
      [
        ids.checkpoint,
        resource.organization_id,
        resource.connection_id,
        resource.installation_id,
        resource.id,
      ],
    );
    // A tracked pull request, task, repository and application as well.
    const seed = await seedTaskAndRepository(f, resource);
    await inTransaction(f, (tx) =>
      registerPullRequest(tx, {
        organizationId: resource.organization_id,
        taskId: seed.taskId,
        repositoryId: seed.repositoryId,
        providerNumber: 5,
        url: "https://github.com/o/r/pull/5",
        headSha: SHA_A,
        baseSha: SHA_B,
      }));
    await removeSeed(f, seed);

    finished = true;
    await f.finish();
  } finally {
    if (!finished) await f.finish();
  }
  // Look from a new connection: the fixture's pools are closed.
  const check = openPgDatabase(readTestDatabaseConfig().databaseUrl);
  try {
    const remaining = async (table: string, column: string, values: string[]) =>
      Number(
        (await check.query<{ count: string }>(
          `select count(*) from bakery.${table} where ${column} = any($1::uuid[])`,
          [values],
        )).rows[0].count,
      );
    assertEquals(
      await remaining("integration_remote_facts", "id", ids.facts),
      0,
    );
    assertEquals(
      await remaining("integration_sync_checkpoints", "id", [ids.checkpoint]),
      0,
    );
    assertEquals(await remaining("inbound_event_routes", "id", [ids.route]), 0);
    assertEquals(
      await remaining("inbound_events", "id", [ids.event, ids.orphanEvent]),
      0,
    );
  } finally {
    await closePgDatabase(check);
  }
});
