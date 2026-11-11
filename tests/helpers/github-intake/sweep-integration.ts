import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { Inngest } from "inngest";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import type { GitHubAppClient } from "../../../apps/server/src/modules/integrations/github-app.ts";
import {
  createIntegrationFactSweep,
  runStreamStep,
  type StepOutcome,
  sweepNext,
} from "../../../apps/server/src/modules/integrations/fact-sweep.ts";
import { registerPullRequest } from "../../../apps/server/src/modules/integrations/pull-requests.ts";
import type { ReconcileDependencies } from "../../../apps/server/src/modules/integrations/reconcile.ts";
import {
  claimDueCheckpoint,
  ensureCheckpoints,
  formatGitHubTime,
  KEYSET_BATCH,
  SYNC_BLOCKED_MS,
  SYNC_REST_MS,
  type SyncStream,
} from "../../../apps/server/src/modules/integrations/sync-checkpoints.ts";
import {
  fakeCommitSha,
  fakeRepositories,
  fakeTimestamp,
} from "../fake-github-app.ts";
import {
  enabledConnection,
  type GitHubAppFixture,
  type ResourceRow,
} from "../github-app-registration.ts";
import {
  beforeQuery,
  flakyDatabase,
  settlesWithin,
  sleep,
  waitUntil,
} from "./faults.ts";
import { removeSeed, seedTaskAndRepository } from "./seed.ts";
import { SHA_A, SHA_B, SHA_C, withFixture } from "./receipts-shared.ts";

/**
 * Issue 71 reconciliation sweep: checkpoints, the keyset issue scan, the pull
 * request and check rotations, scheduling and the live authority recheck,
 * against real Postgres and the fake GitHub.
 */

const T0 = Date.parse("2026-10-30T10:00:00Z");
const SINCE_MODES = ["inclusive", "exclusive"] as const;

/** `count` issue seeds ten seconds apart: no 50 of them fall inside two seconds. */
const spaced = (count: number, from = T0) =>
  Array.from({ length: count }, (_, index) => ({
    updatedAt: fakeTimestamp(from + index * 10_000),
  }));
/** `count` issue seeds that share one `updated_at`. */
const tied = (count: number, at = T0) =>
  Array.from({ length: count }, () => ({ updatedAt: fakeTimestamp(at) }));

type Subject = {
  f: GitHubAppFixture;
  resource: ResourceRow;
  /** GitHub's numeric id of the first selected repository. */
  repositoryId: number;
  connectionId: string;
  installationId: number;
};

async function subjectOf(
  f: GitHubAppFixture,
  options: { selected?: number; repositories?: number } = {},
): Promise<Subject> {
  const connection = await enabledConnection(f, {
    selected: options.selected ?? 1,
    ...(options.repositories === undefined ? {} : {
      repositories: fakeRepositories(options.repositories, ["admin"]).map((
        repository,
      ) => ({ ...repository, archived: false })),
    }),
  });
  const resource = connection.selected[0];
  return {
    f,
    resource,
    repositoryId: Number(resource.external_id),
    connectionId: connection.connectionId,
    installationId: connection.installation.id,
  };
}

function dependenciesOf(
  f: GitHubAppFixture,
  github: GitHubAppClient = f.github.client,
): ReconcileDependencies {
  return {
    database: f.runtimePgDatabase!,
    github,
    secretsKey: f.secretsKey,
    broker: f.broker,
  };
}

type CheckpointRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  installation_id: string;
  resource_id: string;
  stream: string;
  cursor: Record<string, unknown> | null;
  status: string;
  generation: number;
  not_before: Date;
  outcome_code: string | null;
  last_started_at: Date | null;
  last_completed_at: Date | null;
  pages_read: number;
  version: number;
};

async function checkpointRows(
  f: GitHubAppFixture,
  resourceId?: string,
): Promise<CheckpointRow[]> {
  return (await f.pgDatabase.query<CheckpointRow>(
    `select * from bakery.integration_sync_checkpoints
      where $1::uuid is null or resource_id = $1
      order by resource_id, stream`,
    [resourceId ?? null],
  )).rows;
}

async function checkpointOf(
  s: Pick<Subject, "f" | "resource">,
  stream: SyncStream,
): Promise<CheckpointRow> {
  const row = (await checkpointRows(s.f, s.resource.id)).find((candidate) =>
    candidate.stream === stream
  );
  assert(row !== undefined, `a ${stream} checkpoint exists`);
  return row;
}

/** Seconds from the database clock until the checkpoint is due; negative when it already is. */
async function secondsUntilDue(
  f: GitHubAppFixture,
  checkpointId: string,
): Promise<number> {
  return Number(
    (await f.pgDatabase.query<{ seconds: string }>(
      `select extract(epoch from (not_before - now()))::float8 as seconds
       from bakery.integration_sync_checkpoints where id = $1`,
      [checkpointId],
    )).rows[0].seconds,
  );
}

async function makeDue(f: GitHubAppFixture, checkpointId: string) {
  await f.pgDatabase.query(
    `update bakery.integration_sync_checkpoints
        set not_before = now() - interval '1 second' where id = $1`,
    [checkpointId],
  );
}

/**
 * Overwrites fields of the cursor a checkpoint holds, as if the scan it stands
 * for had begun, or its mark been set, at another time. The version is left
 * alone, so the next step claims the row as it is.
 */
async function patchCursor(
  f: GitHubAppFixture,
  checkpointId: string,
  patch: Record<string, string>,
) {
  await f.pgDatabase.query(
    `update bakery.integration_sync_checkpoints
        set cursor = cursor || $2::jsonb where id = $1`,
    [checkpointId, JSON.stringify(patch)],
  );
}

/**
 * Creates the checkpoints and runs one step of the stream, unclaimed, with
 * these dependencies; the step's rejection, if any, is the caller's to see.
 */
async function runStep(
  s: Subject,
  stream: SyncStream,
  dependencies: ReconcileDependencies = dependenciesOf(s.f),
  signal: AbortSignal = new AbortController().signal,
): Promise<StepOutcome> {
  await ensureCheckpoints(s.f.runtimePgDatabase!);
  const row = await checkpointOf(s, stream);
  return await runStreamStep(dependencies, row.id, signal);
}

/** Creates the checkpoints and runs one step of the stream, unclaimed. */
async function step(s: Subject, stream: SyncStream): Promise<Stepped> {
  return stepped(await runStep(s, stream));
}

type Stepped = Extract<StepOutcome, { kind: "stepped" }>;

function stepped(outcome: StepOutcome): Stepped {
  assertEquals(outcome.kind, "stepped", JSON.stringify(outcome));
  assert(outcome.kind === "stepped");
  return outcome;
}

type FactRow = {
  kind: string;
  external_id: string;
  number: number | null;
  head_sha: string | null;
  state: string;
  conclusion: string | null;
  provider_updated_at: Date;
  observed_started_at: Date;
  version: number;
  summary: Record<string, unknown>;
};

async function factRows(
  f: GitHubAppFixture,
  kind = "issue",
): Promise<FactRow[]> {
  return (await f.pgDatabase.query<FactRow>(
    `select * from bakery.integration_remote_facts where kind = $1
      order by number nulls last, external_id`,
    [kind],
  )).rows;
}

const numbersOf = (rows: FactRow[]) => rows.map(({ number }) => number);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** The issue-list requests the fake GitHub received, in order. */
function listCalls(f: GitHubAppFixture): URL[] {
  return f.github.repositoryReadCalls().map((call) => new URL(call.url))
    .filter((url) => url.pathname.endsWith("/issues"));
}
const pagesOf = (urls: URL[]) =>
  urls.map((url) => Number(url.searchParams.get("page")));

/**
 * Runs `handler` as each issue-list request arrives at the fake, before it is
 * answered (so a failure scripted in it hits that very request). Returns the
 * call that removes the hook.
 */
function onListRequest(
  f: GitHubAppFixture,
  handler: (nth: number) => Promise<void> | void,
): () => void {
  let nth = 0;
  f.github.hooks.beforeResponse = async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/issues")) {
      nth += 1;
      await handler(nth);
    }
  };
  return () => {
    f.github.hooks.beforeResponse = null;
  };
}

/** Runs the Inngest function body with inline steps. */
function capture() {
  let handler:
    | ((context: { event?: unknown; step: unknown }) => Promise<unknown>)
    | undefined;
  let config: Record<string, unknown> = {};
  const client = {
    createFunction(options: Record<string, unknown>, body: typeof handler) {
      config = options;
      handler = body;
      return {};
    },
  } as unknown as Inngest;
  return {
    client,
    config: () => config,
    run: () =>
      handler!({
        step: {
          run: async <T>(_id: string, work: () => Promise<T>) => await work(),
        },
      }),
  };
}

const NO_TALLY = {
  requests: 0,
  written: 0,
  unchanged: 0,
  stale: 0,
  skipped: 0,
  pullRequestItems: 0,
  rows: 0,
  gone: 0,
  truncated: 0,
};

// ---------------------------------------------------------------- checkpoints

Deno.test("issue 71 sweep: a checkpoint per stream is created for each selected repository only, once", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f, { selected: 2 });
    assertEquals(await checkpointRows(f), []);
    assertEquals(await ensureCheckpoints(f.runtimePgDatabase!), {
      created: 6,
      rearmed: 0,
    });
    assertEquals(await ensureCheckpoints(f.runtimePgDatabase!), {
      created: 0,
      rearmed: 0,
    });
    const rows = await checkpointRows(f);
    assertEquals(rows.length, 6);
    assertEquals(
      new Set(rows.map((row) => row.resource_id)).size,
      2,
      "the unselected third repository has none",
    );
    for (const row of rows) {
      assertEquals(
        [row.status, row.cursor, row.generation, row.last_completed_at],
        ["idle", null, 1, null],
      );
      assertEquals(row.organization_id, f.organizationId);
      assertEquals(row.connection_id, s.connectionId);
    }
    assertEquals(
      rows.map((row) => row.stream).sort(),
      [
        "checks",
        "checks",
        "issues",
        "issues",
        "pull_requests",
        "pull_requests",
      ],
    );
    // A cursor is kept: the existing row is not replaced.
    await step(s, "issues");
    const ran = await checkpointOf(s, "issues");
    assertEquals(await ensureCheckpoints(f.runtimePgDatabase!), {
      created: 0,
      rearmed: 0,
    });
    assertEquals((await checkpointOf(s, "issues")).version, ran.version);
  });
});

Deno.test("issue 71 sweep: three pages each commit a checkpoint before the next request, and the scan completes and rests five minutes", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const before = await checkpointOf(s, "issues");
    const seen: { pagesRead: number; edge: unknown }[] = [];
    const unhook = onListRequest(f, async () => {
      const row = await checkpointOf(s, "issues");
      seen.push({
        pagesRead: row.pages_read,
        edge: row.cursor === null ? null : row.cursor.edge,
      });
    });
    let outcome: Stepped;
    try {
      outcome = await step(s, "issues");
    } finally {
      unhook();
    }
    // Before each request the checkpoint already holds every page before it.
    assertEquals(seen.map(({ pagesRead }) => pagesRead), [0, 1, 2]);
    assertEquals(seen[0].edge, null);
    assertNotEquals(seen[1].edge, null);
    assertNotEquals(seen[2].edge, seen[1].edge);
    assertEquals(outcome.status, "idle");
    assertEquals(outcome.code, "completed");
    assertEquals(outcome.tally, {
      ...NO_TALLY,
      requests: 3,
      // The edge item of page 1 and of page 2 is read again, harmlessly.
      written: 120,
      unchanged: 2,
    });
    const urls = listCalls(f);
    assertEquals(pagesOf(urls), [1, 1, 1]);
    assertEquals(urls[0].searchParams.get("state"), "open");
    assertEquals(urls[0].searchParams.get("since"), null);
    assertEquals(urls[0].searchParams.get("per_page"), "50");
    assertEquals(urls[0].searchParams.get("sort"), "updated");
    assertEquals(urls[0].searchParams.get("direction"), "asc");
    // The edge is the 50th issue's update; the next request starts one second before it.
    assertEquals(
      urls[1].searchParams.get("since"),
      fakeTimestamp(T0 + 49 * 10_000 - 1000),
    );
    assertEquals(numbersOf(await factRows(f)), range(1, 120));
    const after = await checkpointOf(s, "issues");
    assertEquals(after.status, "idle");
    assertEquals(after.outcome_code, "completed");
    assertEquals(after.generation, before.generation + 1);
    assertEquals(after.pages_read, 3);
    assertNotEquals(after.last_completed_at, null);
    assertEquals(after.cursor?.edge, null);
    assertEquals(after.cursor?.k, 1);
    assertEquals(after.cursor?.initial, false);
    const wait = await secondsUntilDue(f, after.id);
    assert(
      wait > 295 && wait <= 300,
      `rests about five minutes, not ${wait} s`,
    );
  });
});

for (const mode of SINCE_MODES) {
  Deno.test(`issue 71 sweep (${mode} since): 120 issues sharing one updated_at are all observed in 1 + ceil(120 / 50) requests, walking pages 1, 1, 2, 3`, async () => {
    await withFixture(async (f) => {
      f.github.issueListing.sinceMode = mode;
      const s = await subjectOf(f);
      f.github.seedIssues(s.repositoryId, tied(120));
      const outcome = await step(s, "issues");
      assertEquals(outcome.code, "completed");
      assertEquals(outcome.tally.requests, 4);
      assertEquals(pagesOf(listCalls(f)), [1, 1, 2, 3]);
      assertEquals(numbersOf(await factRows(f)), range(1, 120));
    });
  });

  Deno.test(`issue 71 sweep (${mode} since): 30 issues at S and 70 at S+1 do not stall and are all observed`, async () => {
    await withFixture(async (f) => {
      f.github.issueListing.sinceMode = mode;
      const s = await subjectOf(f);
      f.github.seedIssues(s.repositoryId, [
        ...tied(30, T0),
        ...tied(70, T0 + 1000),
      ]);
      const outcome = await step(s, "issues");
      assertEquals(outcome.code, "completed");
      assertEquals(outcome.tally.requests, 3);
      assertEquals(numbersOf(await factRows(f)), range(1, 100));
    });
  });

  Deno.test(`issue 71 sweep (${mode} since): a boundary that falls exactly on a page end loses nothing, and one page of one second is one request`, async () => {
    await withFixture(async (f) => {
      f.github.issueListing.sinceMode = mode;
      const s = await subjectOf(f);
      f.github.seedIssues(s.repositoryId, [
        ...tied(50, T0),
        ...tied(50, T0 + 1000),
      ]);
      const first = await step(s, "issues");
      assertEquals(first.tally.requests, 3);
      assertEquals(numbersOf(await factRows(f)), range(1, 100));
    });
    await withFixture(async (f) => {
      f.github.issueListing.sinceMode = mode;
      const s = await subjectOf(f);
      f.github.seedIssues(s.repositoryId, tied(50));
      const only = await step(s, "issues");
      assertEquals(only.tally.requests, 1);
      assertEquals(numbersOf(await factRows(f)), range(1, 50));
    });
  });
}

Deno.test("issue 71 sweep: a failed page leaves the checkpoint at its cursor, and the next sweep resumes at the edge, so an already-read issue edited in between hides nothing", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    const unhook = onListRequest(f, (nth) => {
      if (nth === 2) f.github.failNext("issues", "server_error");
    });
    let first: Stepped;
    try {
      first = await step(s, "issues");
    } finally {
      unhook();
    }
    assertEquals([first.status, first.code], ["partial", "provider_error"]);
    assertEquals(first.waitMs, SYNC_REST_MS);
    assertEquals(first.tally.requests, 1);
    assertEquals(numbersOf(await factRows(f)).length, 50);
    const stopped = await checkpointOf(s, "issues");
    assertEquals(stopped.status, "partial");
    assertEquals(stopped.outcome_code, "provider_error");
    assertEquals(stopped.pages_read, 1);
    assertEquals(stopped.cursor?.k, 1);
    assertNotEquals(stopped.cursor?.edge, null);
    const wait = await secondsUntilDue(f, stopped.id);
    assert(
      wait > 295 && wait <= 300,
      `waits about five minutes, not ${wait} s`,
    );
    assertEquals(
      await claimDueCheckpoint(f.runtimePgDatabase!, [
        ...(await checkpointRows(f)).filter((row) => row.stream !== "issues")
          .map((row) => row.id),
      ]),
      null,
      "the failed checkpoint is not due before its wait is over",
    );

    // An issue the scan already read is edited while it waits: GitHub moves
    // it to the end of the list, which would hide issue 51 from a stored page.
    const edited = f.github.editIssue(s.repositoryId, 5, { labels: ["moved"] });
    await makeDue(f, stopped.id);
    f.github.calls.length = 0;
    const second = await step(s, "issues");
    assertEquals([second.status, second.code], ["idle", "completed"]);
    assertEquals(
      listCalls(f)[0].searchParams.get("page"),
      "1",
      "the resumed request restarts at page 1 of the window, not a stored offset",
    );
    const facts = await factRows(f);
    assertEquals(numbersOf(facts), range(1, 120), "every issue is observed");
    const fiveFact = facts.find(({ number }) => number === 5)!;
    assertEquals(fiveFact.summary.labels, ["moved"]);
    assertEquals(
      fiveFact.provider_updated_at.toISOString(),
      new Date(edited.updatedAt).toISOString(),
    );
  });
});

Deno.test("issue 71 sweep: an already-read issue edited and another closed between pages hide no unedited issue", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    const unhook = onListRequest(f, (nth) => {
      if (nth === 2) {
        f.github.editIssue(s.repositoryId, 5, { labels: ["moved"] });
        f.github.editIssue(s.repositoryId, 6, { state: "closed" });
      }
    });
    try {
      const outcome = await step(s, "issues");
      assertEquals(outcome.code, "completed");
    } finally {
      unhook();
    }
    const facts = await factRows(f);
    // Issue 6 was closed after the open-only scan read it, so it is stored
    // open until the next scan lists it closed (corrected in the test below).
    assertEquals(numbersOf(facts), range(1, 120));
    assertEquals(facts.find(({ number }) => number === 5)!.summary.labels, [
      "moved",
    ]);
  });
});

Deno.test("issue 71 sweep: an issue closed during the initial scan keeps a stale open fact until the first incremental scan corrects it", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    const unhook = onListRequest(f, (nth) => {
      if (nth === 2) f.github.editIssue(s.repositoryId, 6, { state: "closed" });
    });
    try {
      await step(s, "issues");
    } finally {
      unhook();
    }
    const stale = (await factRows(f)).find(({ number }) => number === 6)!;
    assertEquals(stale.state, "open");
    const done = await checkpointOf(s, "issues");
    await makeDue(f, done.id);
    f.github.calls.length = 0;
    const next = await step(s, "issues");
    assertEquals(next.code, "completed");
    const urls = listCalls(f);
    assertEquals(urls[0].searchParams.get("state"), "all");
    const runStartedAt = Date.parse(String(done.cursor?.runStartedAt));
    assertEquals(
      urls[0].searchParams.get("since"),
      formatGitHubTime(runStartedAt - 120_000),
      "the first incremental request starts two minutes before the backfill began",
    );
    const corrected = (await factRows(f)).find(({ number }) => number === 6)!;
    assertEquals(corrected.state, "closed");
    assertEquals(corrected.version, stale.version + 1);
  });
});

const HOUR_MS = 3_600_000;

for (const cause of ["refused token", "forbidden read"] as const) {
  Deno.test(`issue 71 sweep: a backfill stopped by a ${cause} after its first pages and armed again keeps its first start, so an issue closed between the attempts is corrected by the first incremental scan`, async () => {
    await withFixture(async (f) => {
      const s = await subjectOf(f);
      f.github.seedIssues(s.repositoryId, spaced(300));
      // The first attempt reads five pages and stores the first issues open.
      const first = await step(s, "issues");
      assertEquals([first.status, first.code], ["partial", "request_cap"]);
      const before = (await factRows(f)).find(({ number }) => number === 1)!;
      assertEquals(before.state, "open");
      const partial = await checkpointOf(s, "issues");
      assertEquals(partial.cursor?.initial, true);
      assertNotEquals(partial.cursor?.edge, null);
      // That attempt began an hour after the issues were made. Ten minutes
      // later GitHub closes issue 1, which the scan has already stored open.
      const began = T0 + HOUR_MS;
      await patchCursor(f, partial.id, {
        runStartedAt: formatGitHubTime(began),
      });
      f.github.editIssue(s.repositoryId, 1, {
        state: "closed",
        updatedAt: fakeTimestamp(began + 600_000),
      });

      // The scan is blocked at its next request, keeping the cursor it committed.
      if (cause === "refused token") {
        f.github.setInstallationState(s.installationId, "suspended");
      } else {
        f.github.failNext("issues", "forbidden");
      }
      const blocked = await step(s, "issues");
      assertEquals([blocked.status, blocked.code], [
        "blocked",
        "permission_missing",
      ]);
      const stopped = await checkpointOf(s, "issues");
      assertEquals(stopped.status, "blocked");
      assertEquals(stopped.cursor?.initial, true);
      assertEquals(stopped.cursor?.edge, partial.cursor?.edge);
      assertEquals(stopped.cursor?.runStartedAt, formatGitHubTime(began));

      // The permission returns and the blocked window is over: armed again.
      if (cause === "refused token") {
        f.github.setInstallationState(s.installationId, "active");
      }
      await makeDue(f, stopped.id);
      assertEquals((await ensureCheckpoints(f.runtimePgDatabase!)).rearmed, 1);
      assertEquals((await checkpointOf(s, "issues")).status, "idle");

      // The restarted backfill starts over with open issues only and finishes.
      f.github.calls.length = 0;
      let finished: Stepped | null = null;
      for (let steps = 1; finished === null && steps <= 4; steps++) {
        const outcome = await step(s, "issues");
        if (outcome.code === "completed") finished = outcome;
      }
      assert(finished !== null, "the restarted backfill completes");
      const restart = listCalls(f)[0];
      assertEquals(restart.searchParams.get("state"), "open");
      assertEquals(restart.searchParams.get("since"), null);
      assertEquals(restart.searchParams.get("page"), "1");
      const done = await checkpointOf(s, "issues");
      assertEquals(done.cursor?.initial, false);
      assertEquals(
        done.cursor?.highWater,
        formatGitHubTime(began - 60_000),
        "the mark comes from the first attempt's start, not from the restart",
      );
      // The open-only list no longer shows issue 1: its fact is still open.
      const stale = (await factRows(f)).find(({ number }) => number === 1)!;
      assertEquals(stale.state, "open");
      assertEquals(stale.version, before.version);

      // The first incremental scan starts two minutes before the first attempt
      // began, which reaches the closure, and corrects the fact.
      await makeDue(f, done.id);
      f.github.calls.length = 0;
      const incremental = await step(s, "issues");
      assertEquals(incremental.code, "completed");
      const window = listCalls(f)[0];
      assertEquals(window.searchParams.get("state"), "all");
      assertEquals(
        window.searchParams.get("since"),
        formatGitHubTime(began - 120_000),
      );
      const corrected = (await factRows(f)).find(({ number }) => number === 1)!;
      assertEquals(corrected.state, "closed");
      assertEquals(corrected.version, stale.version + 1);
    });
  });
}

Deno.test("issue 71 sweep: an incremental scan blocked mid-way and armed again reads again from its mark, so an issue closed between the attempts is corrected by the restarted scan", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(130));
    assertEquals((await step(s, "issues")).code, "completed");
    const backfill = await checkpointOf(s, "issues");
    // The backfill's mark is an hour after the issues were made; 120 issues
    // change after it, ten seconds apart, and issue 1 stays outside the window.
    const mark = T0 + HOUR_MS;
    await patchCursor(f, backfill.id, { highWater: formatGitHubTime(mark) });
    for (let number = 2; number <= 121; number++) {
      f.github.editIssue(s.repositoryId, number, {
        labels: ["edited"],
        updatedAt: fakeTimestamp(mark + number * 10_000),
      });
    }
    await makeDue(f, backfill.id);
    const unhook = onListRequest(f, (nth) => {
      if (nth === 2) f.github.failNext("issues", "forbidden");
    });
    let blocked: Stepped;
    try {
      blocked = await step(s, "issues");
    } finally {
      unhook();
    }
    assertEquals([blocked.status, blocked.code], [
      "blocked",
      "permission_missing",
    ]);
    assertEquals(blocked.tally.requests, 1);
    const stopped = await checkpointOf(s, "issues");
    assertEquals(stopped.cursor?.initial, false);
    assertNotEquals(stopped.cursor?.edge, null);
    assertEquals(stopped.cursor?.highWater, formatGitHubTime(mark));
    assertEquals(
      (await factRows(f)).find(({ number }) => number === 1)!.state,
      "open",
    );

    // Issue 1 is closed after the attempt stopped; the checkpoint is armed again.
    f.github.editIssue(s.repositoryId, 1, {
      state: "closed",
      updatedAt: fakeTimestamp(mark + 1_800_000),
    });
    await makeDue(f, stopped.id);
    assertEquals((await ensureCheckpoints(f.runtimePgDatabase!)).rearmed, 1);
    f.github.calls.length = 0;
    const restarted = await step(s, "issues");
    assertEquals([restarted.status, restarted.code], ["idle", "completed"]);
    const first = listCalls(f)[0];
    assertEquals(first.searchParams.get("state"), "all");
    assertEquals(
      first.searchParams.get("since"),
      formatGitHubTime(mark - 60_000),
      "the restart reads again from the mark, not from the stopped edge",
    );
    assertEquals(first.searchParams.get("page"), "1");
    const facts = await factRows(f);
    assertEquals(facts.find(({ number }) => number === 1)!.state, "closed");
    for (const fact of facts.filter(({ number }) => number! >= 2)) {
      if (fact.number! <= 121) {
        assertEquals(fact.summary.labels, ["edited"], `issue ${fact.number}`);
      }
    }
    const done = await checkpointOf(s, "issues");
    assertEquals(done.cursor?.highWater, formatGitHubTime(mark + 1_800_000));
  });
});

Deno.test("issue 71 sweep: the five-request cap leaves the scan partial with its cursor and the next step finishes it", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, tied(300));
    const first = await step(s, "issues");
    assertEquals([first.status, first.code], ["partial", "request_cap"]);
    assertEquals(first.tally.requests, 5);
    assertEquals(first.waitMs, 0);
    const capped = await checkpointOf(s, "issues");
    assertEquals(capped.status, "partial");
    assertEquals(capped.outcome_code, "request_cap");
    assertEquals(capped.cursor?.k, 5);
    assertEquals(capped.cursor?.edge, fakeTimestamp(T0));
    assertEquals(capped.pages_read, 5);
    assertEquals(capped.last_completed_at, null);
    assertEquals(capped.generation, 1);
    assert(await secondsUntilDue(f, capped.id) <= 0, "due at once");
    // Requests 1 to 5 read pages 1, 1, 2, 3 and 4: issues 1 to 200.
    assertEquals(numbersOf(await factRows(f)), range(1, 200));

    const second = await step(s, "issues");
    assertEquals([second.status, second.code], ["idle", "completed"]);
    assertEquals(second.tally.requests, 2);
    assertEquals(pagesOf(listCalls(f)), [1, 1, 2, 3, 4, 5, 6]);
    assertEquals(listCalls(f).length, 1 + Math.ceil(300 / 50));
    assertEquals(numbersOf(await factRows(f)), range(1, 300));
    assertEquals((await checkpointOf(s, "issues")).pages_read, 7);
  });
});

Deno.test("issue 71 sweep: the first backfill lists open issues with no since and the next run lists every state from the mark minus 60 seconds", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, [
      { updatedAt: fakeTimestamp(T0), state: "closed" },
      ...spaced(2, T0 + 10_000),
    ]);
    const first = await step(s, "issues");
    assertEquals(first.tally.requests, 1);
    const urls = listCalls(f);
    assertEquals(urls[0].searchParams.get("state"), "open");
    assertEquals(urls[0].searchParams.get("since"), null);
    assertEquals(numbersOf(await factRows(f)), [2, 3], "open issues only");
    const done = await checkpointOf(s, "issues");
    const runStartedAt = Date.parse(String(done.cursor?.runStartedAt));
    await makeDue(f, done.id);
    const second = await step(s, "issues");
    assertEquals(second.code, "completed");
    const next = listCalls(f)[1];
    assertEquals(next.searchParams.get("state"), "all");
    assertEquals(
      next.searchParams.get("since"),
      formatGitHubTime(runStartedAt - 120_000),
    );
    // The window starts after these old issues: the closed one is not listed.
    assertEquals(numbersOf(await factRows(f)), [2, 3]);
  });
});

Deno.test("issue 71 sweep: pull request items on the issue list are counted and never stored as issue facts", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, [
      { number: 1, updatedAt: fakeTimestamp(T0) },
      { number: 2, updatedAt: fakeTimestamp(T0 + 1000) },
    ]);
    f.github.seedPullRequest(s.repositoryId, {
      number: 3,
      updatedAt: fakeTimestamp(T0 + 2000),
    });
    f.github.seedPullRequest(s.repositoryId, {
      number: 4,
      updatedAt: fakeTimestamp(T0 + 3000),
    });
    const outcome = await step(s, "issues");
    assertEquals(outcome.code, "completed");
    assertEquals(outcome.tally.pullRequestItems, 2);
    assertEquals(outcome.tally.written, 2);
    assertEquals(numbersOf(await factRows(f)), [1, 2]);
    assertEquals((await factRows(f, "check_run")).length, 0);
    assertEquals(
      (await f.pgDatabase.query("select 1 from bakery.pull_requests")).rowCount,
      0,
      "a pull request GitHub lists is never adopted",
    );
  });
});

Deno.test("issue 71 sweep: nothing is marked closed, gone or absent because an issue is missing from a list", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(4));
    await step(s, "issues");
    const stored = await factRows(f);
    assertEquals(stored.map(({ state }) => state), [
      "open",
      "open",
      "open",
      "open",
    ]);
    const issues = await checkpointOf(s, "issues");

    // 1 is closed on GitHub but the next scan fails before it lists it.
    f.github.editIssue(s.repositoryId, 1, { state: "closed" });
    f.github.deleteIssue(s.repositoryId, 2);
    f.github.transferIssue(s.repositoryId, 3);
    await makeDue(f, issues.id);
    f.github.failNext("issues", "server_error");
    const partial = await step(s, "issues");
    assertEquals([partial.status, partial.code], ["partial", "provider_error"]);
    assertEquals(await factRows(f), stored, "a partial scan changed no fact");

    // A complete scan observes the closed issue, and concludes nothing about
    // the two that the list no longer shows.
    await makeDue(f, issues.id);
    const complete = await step(s, "issues");
    assertEquals(complete.code, "completed");
    const after = await factRows(f);
    assertEquals(after.map(({ state }) => state), [
      "closed",
      "open",
      "open",
      "open",
    ]);
    assertEquals(after[1], stored[1], "a deleted issue is not marked gone");
    assertEquals(after[2], stored[2], "a transferred issue is not marked gone");
    assertEquals(after[3], stored[3]);
  });
});

// ------------------------------------------------------------------ failures

Deno.test("issue 71 sweep: a rate limit keeps the cursor and waits the time GitHub named", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    f.github.failNext("issues", "rate_limited");
    const outcome = await step(s, "issues");
    assertEquals([outcome.status, outcome.code], ["partial", "rate_limited"]);
    const row = await checkpointOf(s, "issues");
    assertEquals([row.status, row.outcome_code], ["partial", "rate_limited"]);
    const wait = await secondsUntilDue(f, row.id);
    assert(
      wait > 100 && wait <= 120,
      `waits the 120 seconds GitHub named, not ${wait} s`,
    );
    assertEquals(outcome.waitMs >= 100_000 && outcome.waitMs <= 120_000, true);
    assertEquals(await factRows(f), []);
    // Due again, it completes.
    await makeDue(f, row.id);
    assertEquals((await step(s, "issues")).code, "completed");
    assertEquals(numbersOf(await factRows(f)), [1, 2, 3]);
  });
});

Deno.test("issue 71 sweep: a forbidden read or a refused token blocks the checkpoint for 30 minutes, then ensureCheckpoints arms it again", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    // GitHub suspended the installation before Bakery knew: the token mint is refused.
    f.github.setInstallationState(s.installationId, "suspended");
    const refused = await step(s, "issues");
    assertEquals([refused.status, refused.code], [
      "blocked",
      "permission_missing",
    ]);
    assertEquals(f.github.repositoryReadCalls().length, 0, "no read was made");
    const row = await checkpointOf(s, "issues");
    assertEquals([row.status, row.outcome_code], [
      "blocked",
      "permission_missing",
    ]);
    const wait = await secondsUntilDue(f, row.id);
    assert(
      wait > SYNC_BLOCKED_MS / 1000 - 5 && wait <= SYNC_BLOCKED_MS / 1000,
      `waits about 30 minutes, not ${wait} s`,
    );
    // Blocked is never claimed, and not armed before its window is over.
    assertEquals(await ensureCheckpoints(f.runtimePgDatabase!), {
      created: 0,
      rearmed: 0,
    });
    assertEquals((await checkpointOf(s, "issues")).status, "blocked");

    // The window ends; a disabled connection's checkpoint stays blocked.
    await makeDue(f, row.id);
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'disabled' where id = $1",
      [s.connectionId],
    );
    assertEquals((await ensureCheckpoints(f.runtimePgDatabase!)).rearmed, 0);
    assertEquals((await checkpointOf(s, "issues")).status, "blocked");
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'enabled' where id = $1",
      [s.connectionId],
    );
    // The permission is restored: the next pass arms it and the scan completes.
    f.github.setInstallationState(s.installationId, "active");
    assertEquals((await ensureCheckpoints(f.runtimePgDatabase!)).rearmed, 1);
    assertEquals((await checkpointOf(s, "issues")).status, "idle");
    assertEquals((await step(s, "issues")).code, "completed");
    assertEquals(numbersOf(await factRows(f)), [1, 2, 3]);

    // A read GitHub answers 403 blocks the same way.
    await makeDue(f, row.id);
    f.github.failNext("issues", "forbidden");
    const forbidden = await step(s, "issues");
    assertEquals([forbidden.status, forbidden.code], [
      "blocked",
      "permission_missing",
    ]);
  });
});

// ----------------------------------------------------- eligibility and claims

Deno.test("issue 71 sweep: a deselected repository or a revoked connection gets no step and no provider call", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f, { selected: 2 });
    await ensureCheckpoints(f.runtimePgDatabase!);
    const second = (await f.pgDatabase.query<{ id: string }>(
      `select id from bakery.integration_resources
        where connection_id = $1 and selected and id <> $2`,
      [s.connectionId, s.resource.id],
    )).rows[0].id;

    // Deselected after the checkpoints exist: they are never claimed.
    await f.pgDatabase.query(
      "update bakery.integration_resources set selected = false where id = $1",
      [s.resource.id],
    );
    const claimed: string[] = [];
    for (;;) {
      const next = await claimDueCheckpoint(f.runtimePgDatabase!, claimed);
      if (next === null) break;
      claimed.push(next.id);
      assertEquals(
        next.resourceId,
        second,
        "only the still-selected repository",
      );
    }
    assertEquals(claimed.length, 3);

    // A checkpoint already claimed is parked by the recheck, with no call.
    const parked = (await checkpointRows(f, s.resource.id))[0];
    const outcome = stepped(
      await runStreamStep(
        dependenciesOf(f),
        parked.id,
        new AbortController().signal,
      ),
    );
    assertEquals([outcome.code, outcome.reason], [
      "ineligible",
      "unselected_repository",
    ]);
    assertEquals(f.github.repositoryReadCalls().length, 0);
    assertEquals(f.github.tokenRequests.length, 0);
    const row = (await checkpointRows(f, s.resource.id)).find(({ id }) =>
      id === parked.id
    )!;
    assertEquals(row.outcome_code, "ineligible");
    assertEquals(row.status, parked.status);
    const wait = await secondsUntilDue(f, row.id);
    assert(wait > 295 && wait <= 300);

    // A revoked connection: nothing is claimed and a direct step is parked.
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'revoked' where id = $1",
      [s.connectionId],
    );
    assertEquals(
      await claimDueCheckpoint(f.runtimePgDatabase!, claimed),
      null,
    );
    const revoked = (await checkpointRows(f, second))[0];
    const result = stepped(
      await runStreamStep(
        dependenciesOf(f),
        revoked.id,
        new AbortController().signal,
      ),
    );
    assertEquals([result.code, result.reason], [
      "ineligible",
      "connection_not_enabled",
    ]);
    assertEquals(f.github.repositoryReadCalls().length, 0);
  });
});

Deno.test("issue 71 sweep: a repository whose authority is gone gets no checkpoint, no claim, no token and no read, whichever row lost it", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    const database = f.runtimePgDatabase!;
    const states = losses(s);
    const everythingDue = () =>
      f.pgDatabase.query(
        `update bakery.integration_sync_checkpoints
            set not_before = now() - interval '1 second'`,
      );

    // Nothing is created for it.
    for (const state of states) {
      await state.lose();
      assertEquals(
        await ensureCheckpoints(database),
        { created: 0, rearmed: 0 },
        state.name,
      );
      assertEquals(await checkpointRows(f), [], `${state.name}: none exists`);
      await state.restore();
    }
    assertEquals(
      (await ensureCheckpoints(database)).created,
      3,
      "control: with the authority intact every stream is created",
    );

    // Nothing is claimed and a step parks without a token or a read.
    for (const state of states) {
      await state.lose();
      assertEquals(
        await claimDueCheckpoint(database),
        null,
        `${state.name}: nothing is claimable`,
      );
      for (const row of await checkpointRows(f)) {
        const outcome = stepped(
          await runStreamStep(
            dependenciesOf(f),
            row.id,
            new AbortController().signal,
          ),
        );
        assertEquals(
          [outcome.status, outcome.code, outcome.reason, outcome.tally],
          [row.status, "ineligible", state.beforeCode, NO_TALLY],
          `${state.name}: ${row.stream}`,
        );
      }
      assertEquals(f.github.repositoryReadCalls().length, 0, state.name);
      assertEquals(f.github.tokenRequests.length, 0, state.name);
      await state.restore();
      // Control: the same checkpoints are claimable once the authority is back.
      await everythingDue();
      assertNotEquals(
        await claimDueCheckpoint(database),
        null,
        `${state.name}: claimable again after the repair`,
      );
      await everythingDue();
    }

    // A blocked checkpoint is not armed again while its connection or
    // installation has lost the authority, whatever its wait.
    await f.pgDatabase.query(
      `update bakery.integration_sync_checkpoints
          set status = 'blocked', not_before = now() - interval '1 second'`,
    );
    for (const state of states.filter(({ row }) => row !== "resource")) {
      await state.lose();
      assertEquals(
        await ensureCheckpoints(database),
        { created: 0, rearmed: 0 },
        state.name,
      );
      assertEquals(
        (await checkpointRows(f)).map(({ status }) => status),
        ["blocked", "blocked", "blocked"],
        `${state.name}: still blocked`,
      );
      await state.restore();
    }
    assertEquals(
      await ensureCheckpoints(database),
      { created: 0, rearmed: 3 },
      "control: armed again once the authority is back",
    );
  });
});

Deno.test("issue 71 sweep: the authority is rechecked before every request, so a repository deselected between pages gets no further call", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    const [deselect] = losses(s);
    // The repository is deselected after the first page is stored and just
    // before the recheck that precedes the second request.
    const database = beforeQuery(
      f.runtimePgDatabase!,
      /select connection\.status as "connectionStatus"/,
      2,
      deselect.lose,
    );
    const outcome = stepped(
      await runStep(s, "issues", { ...dependenciesOf(f), database }),
    );
    assertEquals(listCalls(f).length, 1, "no second request");
    assertEquals([outcome.status, outcome.code, outcome.reason], [
      "partial",
      "ineligible",
      "unselected_repository",
    ]);
    const row = await checkpointOf(s, "issues");
    assertEquals(row.pages_read, 1, "the page read is kept");
    assertNotEquals(row.cursor?.edge, null);
    assertEquals(numbersOf(await factRows(f)), range(1, 50));
  });
});

Deno.test("issue 71 sweep: concurrent claims take disjoint checkpoints and a claim leases the row", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f, { selected: 3 });
    await ensureCheckpoints(f.runtimePgDatabase!);
    const claims = await Promise.all(
      Array.from(
        { length: 9 },
        () => claimDueCheckpoint(f.runtimePgDatabase!),
      ),
    );
    const ids = claims.map((claim) => claim?.id);
    assert(ids.every((id) => typeof id === "string"), "nine due, nine claimed");
    assertEquals(new Set(ids).size, 9, "no checkpoint is claimed twice");
    assertEquals(await claimDueCheckpoint(f.runtimePgDatabase!), null);
    const rows = await checkpointRows(f);
    for (const row of rows) {
      const wait = await secondsUntilDue(f, row.id);
      assert(wait > 595 && wait <= 600, `leased ten minutes, not ${wait} s`);
      assertNotEquals(row.last_started_at, null);
      assertEquals(row.version, 2);
    }
    assertEquals(claims[0]!.organizationId, f.organizationId);
    assertEquals(s.connectionId.length > 0, true);
    // The lease ends, the checkpoint is due again, and excluding skips it.
    await makeDue(f, claims[0]!.id);
    assertEquals(
      await claimDueCheckpoint(f.runtimePgDatabase!, [claims[0]!.id]),
      null,
    );
    assertEquals(
      (await claimDueCheckpoint(f.runtimePgDatabase!))?.id,
      claims[0]!.id,
    );
  });
});

Deno.test("issue 71 sweep: a step whose lease was taken over writes nothing", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const row = await checkpointOf(s, "issues");
    const unhook = onListRequest(f, async () => {
      // Another worker claims the checkpoint while this step is mid-request.
      await f.pgDatabase.query(
        "update bakery.integration_sync_checkpoints set version = version + 1 where id = $1",
        [row.id],
      );
    });
    try {
      assertEquals(
        await runStreamStep(
          dependenciesOf(f),
          row.id,
          new AbortController().signal,
        ),
        { kind: "skipped", reason: "superseded" },
      );
    } finally {
      unhook();
    }
    assertEquals(await factRows(f), [], "the page's facts rolled back with it");
    const after = await checkpointOf(s, "issues");
    assertEquals([after.status, after.pages_read, after.cursor], [
      "idle",
      0,
      null,
    ]);
    assertEquals(
      await runStreamStep(
        dependenciesOf(f),
        crypto.randomUUID(),
        new AbortController().signal,
      ),
      { kind: "skipped", reason: "not_found" },
    );
  });
});

Deno.test("issue 71 sweep: with 30 checkpoints and a 25-step cap every checkpoint runs within two sweeps", async () => {
  await withFixture(async (f) => {
    await subjectOf(f, { selected: 10, repositories: 10 });
    const sweep = capture();
    createIntegrationFactSweep({
      client: sweep.client,
      ...dependenciesOf(f),
    });
    assertEquals(sweep.config().id, "bakery-integration-fact-sweep");
    assertEquals(sweep.config().triggers, [{ cron: "*/5 * * * *" }]);
    assertEquals(sweep.config().concurrency, [{ limit: 1 }]);
    const first = await sweep.run() as {
      created: number;
      ran: number;
      outcomes: Record<string, number>;
    };
    assertEquals([first.created, first.ran], [30, 25]);
    assertEquals(first.outcomes, { completed: 25 });
    const completed = (await checkpointRows(f)).filter((row) =>
      row.last_completed_at !== null
    );
    assertEquals(completed.length, 25);
    // The five never-completed checkpoints go first in the next sweep, and the
    // 25 that just rested are not due.
    const second = await sweep.run() as { created: number; ran: number };
    assertEquals([second.created, second.ran], [0, 5]);
    const rows = await checkpointRows(f);
    assertEquals(rows.length, 30);
    assertEquals(rows.every((row) => row.last_completed_at !== null), true);
    assertEquals(rows.every((row) => row.generation === 2), true);
    const third = await sweep.run() as { ran: number };
    assertEquals(third.ran, 0, "everything rests for five minutes");
  });
});

Deno.test("issue 71 sweep: a claim goes to the checkpoint that has waited longest, never-completed first, and skips a row another worker holds", async () => {
  await withFixture(async (f) => {
    await subjectOf(f, { selected: 10, repositories: 10 });
    const sweep = capture();
    createIntegrationFactSweep({
      client: sweep.client,
      ...dependenciesOf(f),
    });
    const first = await sweep.run() as { created: number; ran: number };
    assertEquals([first.created, first.ran], [30, 25]);
    // All 30 are due again: five never completed, 25 completed one after another.
    await f.pgDatabase.query(
      `update bakery.integration_sync_checkpoints
          set not_before = now() - interval '1 second'`,
    );
    const rows = await checkpointRows(f);
    const never = rows.filter((row) => row.last_completed_at === null)
      .map((row) => row.id).sort();
    const completed = (await f.pgDatabase.query<{ id: string }>(
      `select id from bakery.integration_sync_checkpoints
        where last_completed_at is not null order by last_completed_at`,
    )).rows.map((row) => row.id);
    assertEquals([never.length, completed.length], [5, 25]);
    const expected = [...never, ...completed];

    const database = f.runtimePgDatabase!;
    // A row another worker holds does not make a claim wait: the next one is taken.
    const holder = await f.pgDatabase.connect();
    let claim: Promise<unknown> | undefined;
    try {
      await holder.query("begin");
      await holder.query(
        "select id from bakery.integration_sync_checkpoints where id = $1 for update",
        [expected[0]],
      );
      const pending = claimDueCheckpoint(database);
      claim = pending;
      const answered = await settlesWithin(3000, pending);
      assert(answered !== "waited", "the claim did not wait for the held row");
      assertEquals(answered.value?.id, expected[1], "the next one was taken");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await claim?.catch(() => undefined);
      holder.release();
    }
    // That claim leased expected[1]; hand it back and walk the whole order.
    await f.pgDatabase.query(
      `update bakery.integration_sync_checkpoints
          set not_before = now() - interval '1 second'`,
    );
    const order: string[] = [];
    for (;;) {
      const next = await claimDueCheckpoint(database, order);
      if (next === null) break;
      order.push(next.id);
    }
    assertEquals(
      order,
      expected,
      "never-completed first, then the oldest completion",
    );
  });
});

Deno.test("issue 71 sweep: one sweep runs a checkpoint at most once, however long its scan", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, tied(300));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const ran: string[] = [];
    for (;;) {
      const result = await sweepNext(
        dependenciesOf(f),
        ran,
        new AbortController().signal,
      );
      if (result === null) break;
      ran.push(result.checkpointId);
    }
    // Three streams, each once: the capped issue scan is partial and due, yet
    // not claimed again in the same sweep.
    assertEquals(ran.length, 3);
    assertEquals(new Set(ran).size, 3);
    assertEquals((await checkpointOf(s, "issues")).status, "partial");
  });
});

// ------------------------------------------------- pull requests and checks

async function trackPullRequests(
  s: Subject,
  seed: { organizationId: string; taskId: string; repositoryId: string },
  numbers: readonly number[],
  heads: ReadonlyMap<number, string>,
) {
  for (const number of numbers) {
    await withPgTransaction(
      s.f.runtimePgDatabase!,
      (transaction) =>
        registerPullRequest(transaction, {
          organizationId: seed.organizationId,
          taskId: seed.taskId,
          repositoryId: seed.repositoryId,
          providerNumber: number,
          url: `https://github.com/example/repo/pull/${number}`,
          headSha: heads.get(number) ?? SHA_A,
          baseSha: SHA_B,
        }),
    );
  }
}

type PullRow = {
  id: string;
  provider_number: number;
  head_sha: string;
  status: string;
  provider_updated_at: Date | null;
  observed_started_at: Date | null;
  last_observed_at: Date | null;
  version: number;
};

/** A row without the two read clocks, which a confirming read moves. */
function stateOf({
  observed_started_at: _started,
  last_observed_at: _observed,
  ...state
}: PullRow) {
  return state;
}

async function pullRows(f: GitHubAppFixture): Promise<PullRow[]> {
  return (await f.pgDatabase.query<PullRow>(
    "select * from bakery.pull_requests order by id",
  )).rows;
}

const readUrls = (f: GitHubAppFixture) =>
  f.github.repositoryReadCalls().map((call) => new URL(call.url).pathname);

Deno.test("issue 71 sweep: the pull request and check streams read tracked rows only and never adopt what GitHub lists", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [7], new Map([[7, SHA_A]]));
      f.github.seedPullRequest(s.repositoryId, { number: 7, headSha: SHA_A });
      f.github.seedPullRequest(s.repositoryId, { number: 8, headSha: SHA_B });
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [{}, { name: "lint" }]);
      f.github.seedCheckRuns(s.repositoryId, SHA_B, [{}]);
      const fullName = s.resource.display_name;

      const pulls = await step(s, "pull_requests");
      assertEquals([pulls.status, pulls.code], ["idle", "completed"]);
      assertEquals(pulls.tally.rows, 1);
      assertEquals(pulls.tally.requests, 1);
      assertEquals(pulls.tally.written, 1);
      assertEquals(readUrls(f), [`/repos/${fullName}/pulls/7`]);
      assertEquals(
        (await pullRows(f)).length,
        1,
        "pull request 8 is not adopted",
      );
      assertNotEquals((await pullRows(f))[0].provider_updated_at, null);

      f.github.calls.length = 0;
      const checks = await step(s, "checks");
      assertEquals([checks.status, checks.code], ["idle", "completed"]);
      assertEquals(checks.tally.rows, 1);
      assertEquals(checks.tally.written, 2);
      assertEquals(readUrls(f), [
        `/repos/${fullName}/commits/${SHA_A}/check-runs`,
      ]);
      const runs = await factRows(f, "check_run");
      assertEquals(runs.length, 2);
      assertEquals(runs.every(({ head_sha }) => head_sha === SHA_A), true);
      assertEquals((await factRows(f)).length, 0, "no issue fact is written");

      // Issue streams never write pull request rows either.
      const issues = await step(s, "issues");
      assertEquals(issues.tally.pullRequestItems, 2);
      assertEquals((await pullRows(f)).length, 1);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: the pull request and check rotations read open rows only, never a merged or a closed one", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(
        s,
        seed,
        [1, 2, 3],
        new Map([[1, SHA_A], [2, SHA_B], [3, SHA_C]]),
      );
      await f.pgDatabase.query(
        `update bakery.pull_requests
            set status = case provider_number
              when 2 then 'merged' else 'closed' end,
                merged_sha = case provider_number when 2 then $1 end
          where provider_number in (2, 3)`,
        [SHA_C],
      );
      for (
        const [number, head] of [[1, SHA_A], [2, SHA_B], [3, SHA_C]] as const
      ) {
        f.github.seedPullRequest(s.repositoryId, { number, headSha: head });
        f.github.seedCheckRuns(s.repositoryId, head, [{
          name: `run-${number}`,
        }]);
      }
      const fullName = s.resource.display_name;

      const pulls = await step(s, "pull_requests");
      assertEquals([pulls.status, pulls.code], ["idle", "completed"]);
      assertEquals([pulls.tally.rows, pulls.tally.requests], [1, 1]);
      assertEquals(readUrls(f), [`/repos/${fullName}/pulls/1`]);

      f.github.calls.length = 0;
      const checks = await step(s, "checks");
      assertEquals([checks.status, checks.code], ["idle", "completed"]);
      assertEquals([checks.tally.rows, checks.tally.requests], [1, 1]);
      assertEquals(readUrls(f), [
        `/repos/${fullName}/commits/${SHA_A}/check-runs`,
      ]);
      assertEquals(
        (await factRows(f, "check_run")).map(({ summary }) => summary.name),
        ["run-1"],
      );
      assertEquals(
        (await pullRows(f)).map(({ provider_number, provider_updated_at }) => [
          provider_number,
          provider_updated_at !== null,
        ]).sort(),
        [[1, true], [2, false], [3, false]],
        "only the open row was observed",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a repository with no tracked pull request completes without a token or a provider call", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedPullRequest(s.repositoryId, { number: 1 });
    for (const stream of ["pull_requests", "checks"] as const) {
      const outcome = await step(s, stream);
      assertEquals([outcome.status, outcome.code], ["idle", "completed"]);
      assertEquals(outcome.tally, NO_TALLY);
      const row = await checkpointOf(s, stream);
      assertEquals(row.cursor, { after: null });
      assertEquals(row.generation, 2);
      const wait = await secondsUntilDue(f, row.id);
      assert(wait > 295 && wait <= 300);
    }
    assertEquals(f.github.repositoryReadCalls().length, 0);
    assertEquals(f.github.tokenRequests.length, 0);
  });
});

Deno.test("issue 71 sweep: the pull request rotation takes 25 rows by id, keeps a keyset cursor, wraps at the end and does not depend on when a row was last observed", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      const numbers = range(1, 30);
      const heads = new Map(numbers.map((number) => [number, fakeCommitSha()]));
      await trackPullRequests(s, seed, numbers, heads);
      for (const number of numbers) {
        f.github.seedPullRequest(s.repositoryId, {
          number,
          headSha: heads.get(number),
        });
      }
      const byId = (await pullRows(f)).map(({ id }) => id);
      assertEquals(byId.length, 30);

      const first = await step(s, "pull_requests");
      assertEquals([first.status, first.code], ["partial", "request_cap"]);
      assertEquals(first.tally.rows, KEYSET_BATCH);
      assertEquals(first.tally.written, KEYSET_BATCH);
      const mid = await checkpointOf(s, "pull_requests");
      assertEquals(mid.cursor, { after: byId[KEYSET_BATCH - 1] });
      assertEquals(mid.status, "partial");
      assertEquals(mid.pages_read, KEYSET_BATCH);
      assert(await secondsUntilDue(f, mid.id) <= 0);

      const second = await step(s, "pull_requests");
      assertEquals([second.status, second.code], ["idle", "completed"]);
      assertEquals(second.tally.rows, 5);
      assertEquals((await checkpointOf(s, "pull_requests")).cursor, {
        after: null,
      });
      assertEquals(
        (await pullRows(f)).every((row) => row.last_observed_at !== null),
        true,
      );

      // Another rotation starts at the first row again. Its reads confirm the
      // stored state: they move the read clocks of the rows they reach and
      // nothing else, and the keyset advances whether or not a clock moved.
      const before = await pullRows(f);
      await makeDue(f, mid.id);
      const third = await step(s, "pull_requests");
      assertEquals([third.status, third.code], ["partial", "request_cap"]);
      assertEquals(third.tally.rows, KEYSET_BATCH);
      assertEquals(third.tally.unchanged, KEYSET_BATCH);
      assertEquals(third.tally.written, 0);
      assertEquals((await checkpointOf(s, "pull_requests")).cursor, {
        after: byId[KEYSET_BATCH - 1],
      });
      const after = await pullRows(f);
      assertEquals(after.map(stateOf), before.map(stateOf), "no state moved");
      assertEquals(
        after.map(({ version }) => version),
        before.map(({ version }) => version),
        "a confirming read leaves the version",
      );
      for (const [index, row] of after.entries()) {
        const was = before[index];
        if (index < KEYSET_BATCH) {
          assert(
            row.last_observed_at! > was.last_observed_at! &&
              row.observed_started_at! > was.observed_started_at!,
            `row ${index} was read again and its clocks moved`,
          );
        } else {
          assertEquals(row, was, `row ${index} was not reached`);
        }
      }
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a pull request GitHub answers 404 for, or a moved repository path, concludes nothing", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [1, 2], new Map());
      f.github.seedPullRequest(s.repositoryId, { number: 2, headSha: SHA_A });
      // Pull request 1 is unknown to GitHub (404); 2 reads.
      const outcome = await step(s, "pull_requests");
      assertEquals([outcome.status, outcome.code], ["idle", "completed"]);
      assertEquals([outcome.tally.gone, outcome.tally.written], [1, 1]);
      const rows = await pullRows(f);
      assertEquals(rows.map(({ status }) => status), ["open", "open"]);

      // The repository is renamed: every read is a 301, the step stops.
      f.github.renameRepository(s.repositoryId, "renamed-repo");
      const row = await checkpointOf(s, "pull_requests");
      await makeDue(f, row.id);
      f.github.calls.length = 0;
      const moved = await step(s, "pull_requests");
      assertEquals([moved.status, moved.code], ["partial", "repository_moved"]);
      assertEquals(
        f.github.repositoryReadCalls().length,
        1,
        "stopped at the first 301",
      );
      assertEquals(await pullRows(f), rows, "nothing was written");
      const wait = await secondsUntilDue(f, row.id);
      assert(wait > 295 && wait <= 300);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a check list cut off at four pages is recorded as truncated, skips runs without a time, and stores a missing App as null", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [7], new Map([[7, SHA_A]]));
      f.github.seedPullRequest(s.repositoryId, { number: 7, headSha: SHA_A });
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [
        // No time to order it by: skipped and counted.
        { status: "queued", startedAt: null, completedAt: null },
        // GitHub no longer has the creating App.
        { appId: null, appSlug: null },
        ...Array.from({ length: 208 }, () => ({})),
      ]);
      const outcome = await step(s, "checks");
      assertEquals([outcome.status, outcome.code], [
        "idle",
        "checks_truncated",
      ]);
      assertEquals(outcome.tally.requests, 4);
      assertEquals(outcome.tally.truncated, 1);
      assertEquals(outcome.tally.skipped, 1);
      assertEquals(outcome.tally.written, 199);
      const runs = await factRows(f, "check_run");
      assertEquals(
        runs.length,
        199,
        "the 10 runs past the cap are unknown, not stored",
      );
      assertEquals(
        runs.filter(({ summary }) => summary.appId === null).length,
        1,
      );
      assertEquals(
        (await checkpointOf(s, "checks")).outcome_code,
        "checks_truncated",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a head GitHub fails on is skipped for this rotation, while a rate limit retries the same row", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(
        s,
        seed,
        [1, 2],
        new Map([[1, SHA_A], [2, SHA_B]]),
      );
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [{}, {}]);
      f.github.seedCheckRuns(s.repositoryId, SHA_B, [{}, {}]);
      const [firstRow, secondRow] = await pullRows(f);

      // A rate limit retries the same row: the cursor does not move.
      f.github.failNext("check-runs", "rate_limited");
      const limited = await step(s, "checks");
      assertEquals([limited.status, limited.code], ["partial", "rate_limited"]);
      assertEquals((await checkpointOf(s, "checks")).cursor, null);
      await makeDue(f, (await checkpointOf(s, "checks")).id);

      // An error skips the failing row until the next rotation.
      f.github.failNext("check-runs", "server_error");
      const failed = await step(s, "checks");
      assertEquals([failed.status, failed.code], ["partial", "provider_error"]);
      assertEquals((await checkpointOf(s, "checks")).cursor, {
        after: firstRow.id,
      });
      assertEquals((await factRows(f, "check_run")).length, 0);
      await makeDue(f, (await checkpointOf(s, "checks")).id);

      const next = await step(s, "checks");
      assertEquals([next.status, next.code], ["idle", "completed"]);
      assertEquals(next.tally.rows, 1);
      const runs = await factRows(f, "check_run");
      assertEquals(runs.length, 2);
      assertEquals(
        runs.every(({ head_sha }) => head_sha === secondRow.head_sha),
        true,
        "the row after the failing one was read",
      );
      assertEquals((await checkpointOf(s, "checks")).cursor, { after: null });
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a pull request whose own write fails is skipped for this rotation, so the rows after it are read at the next step and it is retried at the next rotation", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      const heads = new Map([[1, SHA_A], [2, SHA_B], [3, SHA_C]]);
      await trackPullRequests(s, seed, [1, 2, 3], heads);
      for (const [number, head] of heads) {
        f.github.seedPullRequest(s.repositoryId, { number, headSha: head });
      }
      const registered = await pullRows(f);
      const [first, ...rest] = registered;
      // GitHub's answer for the first row is one the store rejects (not a commit).
      let poisoned = true;
      const client = f.github.client;
      const github: GitHubAppClient = {
        ...client,
        readPullRequest: async (request, signal) => {
          const read = await client.readPullRequest(request, signal);
          return poisoned && request.number === first.provider_number &&
              !("kind" in read)
            ? { ...read, headSha: "not-a-commit" }
            : read;
        },
      };

      const failed = stepped(
        await runStep(s, "pull_requests", dependenciesOf(f, github)),
      );
      assertEquals([failed.status, failed.code], ["partial", "provider_error"]);
      assertEquals(failed.tally.rows, 1, "the step ended at the failed row");
      const afterFailure = await checkpointOf(s, "pull_requests");
      assertEquals(afterFailure.cursor, { after: first.id });
      assertEquals(afterFailure.pages_read, 1);
      assertEquals(await pullRows(f), registered, "nothing was stored");

      // Still poisoned, the next step does not stop at the first row again:
      // the rows after it are read and the rotation completes.
      await makeDue(f, afterFailure.id);
      const next = stepped(
        await runStep(s, "pull_requests", dependenciesOf(f, github)),
      );
      assertEquals([next.status, next.code], ["idle", "completed"]);
      assertEquals([next.tally.rows, next.tally.written], [2, 2]);
      const afterRotation = await pullRows(f);
      assertEquals(
        afterRotation.map(({ id, provider_updated_at }) => [
          id,
          provider_updated_at !== null,
        ]),
        [[first.id, false], ...rest.map(({ id }) => [id, true])],
        "the failed row is untouched, the rest are observed",
      );
      assertEquals((await checkpointOf(s, "pull_requests")).cursor, {
        after: null,
      });

      // The next rotation starts at the first row again and reads it.
      poisoned = false;
      await makeDue(f, afterFailure.id);
      const again = stepped(
        await runStep(s, "pull_requests", dependenciesOf(f, github)),
      );
      assertEquals([again.status, again.code], ["idle", "completed"]);
      assertEquals([again.tally.rows, again.tally.written], [3, 1]);
      assertEquals(
        (await pullRows(f)).every(({ provider_updated_at }) =>
          provider_updated_at !== null
        ),
        true,
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a head whose own write fails is skipped for this rotation, so the heads after it are read at the next step and it is retried at the next rotation", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      const heads = new Map([[1, SHA_A], [2, SHA_B], [3, SHA_C]]);
      await trackPullRequests(s, seed, [1, 2, 3], heads);
      for (const [number, head] of heads) {
        f.github.seedCheckRuns(s.repositoryId, head, [{
          name: `run-${number}`,
        }]);
      }
      const [first, ...rest] = await pullRows(f);
      const namesOf = async () =>
        (await factRows(f, "check_run")).map(({ summary, head_sha }) => [
          head_sha,
          summary.name,
        ]).sort();
      const nameOf = (row: PullRow) => `run-${row.provider_number}`;

      // The database refuses the first head's write transaction (connection 1
      // reads the authority, 2 would store the first head, 3 records the stop).
      const flaky = {
        ...dependenciesOf(f),
        database: flakyDatabase(f.runtimePgDatabase!, [2]),
      };
      const failed = stepped(await runStep(s, "checks", flaky));
      assertEquals([failed.status, failed.code], ["partial", "provider_error"]);
      assertEquals(failed.tally.rows, 1, "the step ended at the failed head");
      const afterFailure = await checkpointOf(s, "checks");
      assertEquals(afterFailure.cursor, { after: first.id });
      assertEquals(afterFailure.pages_read, 1);
      assertEquals(await namesOf(), [], "nothing was stored");

      await makeDue(f, afterFailure.id);
      const next = stepped(await runStep(s, "checks"));
      assertEquals([next.status, next.code], ["idle", "completed"]);
      assertEquals([next.tally.rows, next.tally.written], [2, 2]);
      assertEquals(
        await namesOf(),
        rest.map((row) => [row.head_sha, nameOf(row)]).sort(),
        "the heads after the failed one were read; it was not",
      );

      await makeDue(f, afterFailure.id);
      const again = stepped(await runStep(s, "checks"));
      assertEquals([again.status, again.code], ["idle", "completed"]);
      assertEquals(again.tally.rows, 3);
      assertEquals(
        await namesOf(),
        [first, ...rest].map((row) => [row.head_sha, nameOf(row)]).sort(),
        "the next rotation read the first head again",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a blocked checkpoint armed again resumes after the row its rotation stopped at, in both rotations", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      const numbers = range(1, 30);
      const heads = new Map(numbers.map((number) => [number, fakeCommitSha()]));
      await trackPullRequests(s, seed, numbers, heads);
      for (const number of numbers) {
        f.github.seedPullRequest(s.repositoryId, {
          number,
          headSha: heads.get(number),
        });
        f.github.seedCheckRuns(s.repositoryId, heads.get(number)!, [{}]);
      }
      const byId = await pullRows(f);
      const resumedAt = byId[KEYSET_BATCH - 1].id;
      const tail = byId.slice(KEYSET_BATCH);
      const cases = [
        { stream: "pull_requests", route: "pull" },
        { stream: "checks", route: "check-runs" },
      ] as const;
      for (const { stream, route } of cases) {
        // The first 25 rows are read; the next read is refused with a 403.
        const first = await step(s, stream);
        assertEquals([first.status, first.code], ["partial", "request_cap"]);
        assertEquals(first.tally.rows, KEYSET_BATCH, stream);
        f.github.failNext(route, "forbidden");
        f.github.calls.length = 0;
        const blocked = await step(s, stream);
        assertEquals([blocked.status, blocked.code], [
          "blocked",
          "permission_missing",
        ], stream);
        const row = await checkpointOf(s, stream);
        assertEquals([row.status, row.cursor, row.pages_read], [
          "blocked",
          { after: resumedAt },
          KEYSET_BATCH,
        ], `${stream}: blocked where the rotation stopped`);

        // The wait is over: armed again, it keeps the position it stopped at.
        await makeDue(f, row.id);
        assertEquals(
          (await ensureCheckpoints(f.runtimePgDatabase!)).rearmed,
          1,
        );
        const armed = await checkpointOf(s, stream);
        assertEquals([armed.status, armed.cursor], ["idle", {
          after: resumedAt,
        }], stream);

        f.github.calls.length = 0;
        const resumed = await step(s, stream);
        assertEquals(
          [resumed.status, resumed.code],
          ["idle", "completed"],
          stream,
        );
        assertEquals(
          resumed.tally.rows,
          tail.length,
          `${stream}: only the rows after the saved id are read`,
        );
        assertEquals(resumed.tally.requests, tail.length, stream);
        assertEquals(
          readUrls(f).length,
          tail.length,
          `${stream}: ${tail.length} requests reached GitHub`,
        );
        const done = await checkpointOf(s, stream);
        assertEquals([done.cursor, done.pages_read], [
          { after: null },
          byId.length,
        ], `${stream}: the rotation counts its rows across the block`);

        // The next rotation starts at the first row again.
        await makeDue(f, done.id);
        const next = await step(s, stream);
        assertEquals(
          [next.status, next.code],
          ["partial", "request_cap"],
          stream,
        );
        assertEquals(next.tally.rows, KEYSET_BATCH, stream);
      }
    } finally {
      await removeSeed(f, seed);
    }
  });
});

// ------------------------------------------- authority lost during a request

/** The provider reads a sweep step makes, which a test can disturb. */
type Read = "listRepositoryIssues" | "readPullRequest" | "listCheckRuns";

/** A client whose reads first run `before`, as events during a slow provider call would. */
function disturbed(
  f: GitHubAppFixture,
  before: (read: Read) => Promise<void>,
): GitHubAppClient {
  const client = f.github.client;
  return {
    ...client,
    listRepositoryIssues: async (request, signal) => {
      await before("listRepositoryIssues");
      return await client.listRepositoryIssues(request, signal);
    },
    readPullRequest: async (request, signal) => {
      await before("readPullRequest");
      return await client.readPullRequest(request, signal);
    },
    listCheckRuns: async (request, signal) => {
      await before("listCheckRuns");
      return await client.listCheckRuns(request, signal);
    },
  };
}

/** Runs `change` before the first read only, whichever read that is. */
function once(change: () => Promise<unknown>): (read: Read) => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await change();
  };
}

/** Runs `change` before the `nth` read (counted from 1) only. */
function atRead(
  nth: number,
  change: () => Promise<unknown>,
): (read: Read) => Promise<void> {
  let reads = 0;
  return async () => {
    reads += 1;
    if (reads === nth) await change();
  };
}

/** Which row a loss changes: the installation, the connection or the repository resource. */
type LossRow = "installation" | "connection" | "resource";

/**
 * The ways a repository can lose its authority. `code` is the reason the
 * write-time guard gives; `beforeCode` is the one the check before a request
 * gives, which differs for an archived connection (the check finds no
 * connection row to judge, so it names the repository).
 */
function losses(s: Subject) {
  const change = (statement: string, id: string) => () =>
    s.f.pgDatabase.query(statement, [id]);
  const loss = (
    row: LossRow,
    name: string,
    code: string,
    id: string,
    lose: string,
    restore: string,
    beforeCode = code,
  ) => ({
    row,
    name,
    code,
    beforeCode,
    lose: change(lose, id),
    restore: change(restore, id),
  });
  const resource = "update bakery.integration_resources set";
  const connection = "update bakery.integration_connections set";
  const installation = "update bakery.integration_installations set";
  return [
    loss(
      "resource",
      "resource deselected",
      "unselected_repository",
      s.resource.id,
      `${resource} selected = false where id = $1`,
      `${resource} selected = true where id = $1`,
    ),
    loss(
      "resource",
      "resource unavailable",
      "unselected_repository",
      s.resource.id,
      `${resource} available = false where id = $1`,
      `${resource} available = true where id = $1`,
    ),
    loss(
      "resource",
      "resource archived",
      "unselected_repository",
      s.resource.id,
      `${resource} archived_at = now() where id = $1`,
      `${resource} archived_at = null where id = $1`,
    ),
    loss(
      "connection",
      "connection revoked",
      "connection_not_enabled",
      s.connectionId,
      `${connection} status = 'revoked' where id = $1`,
      `${connection} status = 'enabled' where id = $1`,
    ),
    loss(
      "connection",
      "connection disabled",
      "connection_not_enabled",
      s.connectionId,
      `${connection} status = 'disabled' where id = $1`,
      `${connection} status = 'enabled' where id = $1`,
    ),
    loss(
      "connection",
      "connection archived",
      "connection_not_enabled",
      s.connectionId,
      `${connection} archived_at = now() where id = $1`,
      `${connection} archived_at = null where id = $1`,
      "unselected_repository",
    ),
    loss(
      "installation",
      "installation suspended",
      "installation_suspended",
      s.resource.installation_id,
      `${installation} status = 'suspended' where id = $1`,
      `${installation} status = 'enabled' where id = $1`,
    ),
    loss(
      "installation",
      "installation revoked",
      "installation_revoked",
      s.resource.installation_id,
      `${installation} status = 'revoked' where id = $1`,
      `${installation} status = 'enabled' where id = $1`,
    ),
  ];
}

/**
 * The checkpoint after a write the guard refused: the step's own state is as it
 * was, only the outcome and the five-minute wait are new, and one version moved.
 */
async function assertParked(
  s: Subject,
  stream: SyncStream,
  before: CheckpointRow,
  label: string,
) {
  const row = await checkpointOf(s, stream);
  assertEquals(
    [
      row.status,
      row.outcome_code,
      row.cursor,
      row.pages_read,
      row.generation,
      row.last_completed_at,
      row.version,
    ],
    [
      before.status,
      "ineligible",
      before.cursor,
      before.pages_read,
      before.generation,
      before.last_completed_at,
      before.version + 1,
    ],
    label,
  );
  const wait = await secondsUntilDue(s.f, row.id);
  assert(
    wait > 295 && wait <= 300,
    `${label}: parked five minutes, not ${wait} s`,
  );
}

Deno.test("issue 71 sweep: an issue list request that loses its repository, connection or installation stores nothing and parks the checkpoint ineligible", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    await ensureCheckpoints(f.runtimePgDatabase!);
    for (const loss of losses(s)) {
      const before = await checkpointOf(s, "issues");
      const outcome = stepped(
        await runStep(
          s,
          "issues",
          dependenciesOf(f, disturbed(f, once(loss.lose))),
        ),
      );
      await loss.restore();
      assertEquals(
        [outcome.status, outcome.code, outcome.reason],
        ["idle", "ineligible", loss.code],
        loss.name,
      );
      assertEquals(outcome.tally, { ...NO_TALLY, requests: 1 }, loss.name);
      assertEquals(await factRows(f), [], `${loss.name}: no fact was written`);
      await assertParked(s, "issues", before, loss.name);
    }
    // With the authority intact the same step does write.
    const control = await step(s, "issues");
    assertEquals([control.status, control.code], ["idle", "completed"]);
    assertEquals(numbersOf(await factRows(f)), [1, 2, 3]);
  });
});

Deno.test("issue 71 sweep: a repository lost during the second request keeps the first page, stores nothing of the second and resumes at the cursor", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    const [deselect] = losses(s);
    const outcome = stepped(
      await runStep(
        s,
        "issues",
        dependenciesOf(f, disturbed(f, atRead(2, deselect.lose))),
      ),
    );
    await deselect.restore();
    assertEquals(
      [outcome.status, outcome.code, outcome.reason],
      ["partial", "ineligible", "unselected_repository"],
    );
    assertEquals(outcome.tally.requests, 2);
    assertEquals(outcome.tally.written, 50, "the first page only");
    assertEquals(numbersOf(await factRows(f)), range(1, 50));
    const parked = await checkpointOf(s, "issues");
    assertEquals(
      [parked.status, parked.outcome_code, parked.pages_read],
      ["partial", "ineligible", 1],
    );
    assertEquals(parked.cursor?.edge, fakeTimestamp(T0 + 49 * 10_000));
    assertEquals(parked.cursor?.k, 1);
    assertEquals(parked.generation, 1, "the scan did not complete");

    // The authority is back: the next step resumes after the first page.
    f.github.calls.length = 0;
    const resumed = await step(s, "issues");
    assertEquals([resumed.status, resumed.code], ["idle", "completed"]);
    assertEquals(resumed.tally.requests, 2);
    assertEquals(numbersOf(await factRows(f)), range(1, 120));
  });
});

Deno.test("issue 71 sweep: a pull request read that loses its repository, connection or installation observes nothing and parks the checkpoint ineligible", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [7], new Map([[7, SHA_A]]));
      f.github.seedPullRequest(s.repositoryId, { number: 7, headSha: SHA_A });
      await ensureCheckpoints(f.runtimePgDatabase!);
      const registered = await pullRows(f);
      for (const loss of losses(s)) {
        const before = await checkpointOf(s, "pull_requests");
        const outcome = stepped(
          await runStep(
            s,
            "pull_requests",
            dependenciesOf(f, disturbed(f, once(loss.lose))),
          ),
        );
        await loss.restore();
        assertEquals(
          [outcome.status, outcome.code, outcome.reason],
          ["idle", "ineligible", loss.code],
          loss.name,
        );
        assertEquals(
          outcome.tally,
          { ...NO_TALLY, requests: 1, rows: 1 },
          loss.name,
        );
        assertEquals(
          await pullRows(f),
          registered,
          `${loss.name}: the pull request row was not observed`,
        );
        await assertParked(s, "pull_requests", before, loss.name);
      }
      const control = await step(s, "pull_requests");
      assertEquals([control.status, control.code], ["idle", "completed"]);
      assertEquals(control.tally.written, 1);
      assertNotEquals((await pullRows(f))[0].provider_updated_at, null);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a check run list that loses its repository, connection or installation stores nothing and parks the checkpoint ineligible", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [7], new Map([[7, SHA_A]]));
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [{}, { name: "lint" }]);
      await ensureCheckpoints(f.runtimePgDatabase!);
      for (const loss of losses(s)) {
        const before = await checkpointOf(s, "checks");
        const outcome = stepped(
          await runStep(
            s,
            "checks",
            dependenciesOf(f, disturbed(f, once(loss.lose))),
          ),
        );
        await loss.restore();
        assertEquals(
          [outcome.status, outcome.code, outcome.reason],
          ["idle", "ineligible", loss.code],
          loss.name,
        );
        assertEquals(
          outcome.tally,
          { ...NO_TALLY, requests: 1, rows: 1 },
          loss.name,
        );
        assertEquals(
          await factRows(f, "check_run"),
          [],
          `${loss.name}: no check run was stored`,
        );
        await assertParked(s, "checks", before, loss.name);
      }
      const control = await step(s, "checks");
      assertEquals([control.status, control.code], ["idle", "completed"]);
      assertEquals(control.tally.written, 2);
      assertEquals((await factRows(f, "check_run")).length, 2);
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: the write guard share-locks the installation, then the connection, then the resource row", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const issuesCheckpoint = await checkpointOf(s, "issues");
    const rows = {
      installation: {
        id: s.resource.installation_id,
        table: "bakery.integration_installations",
      },
      connection: {
        id: s.connectionId,
        table: "bakery.integration_connections",
      },
      resource: { id: s.resource.id, table: "bakery.integration_resources" },
      checkpoint: {
        id: issuesCheckpoint.id,
        table: "bakery.integration_sync_checkpoints",
      },
    } as const;
    type Name = keyof typeof rows;
    const probe = (name: Name, mode: "update" | "share") =>
      `select id from ${rows[name].table} where id = $1 for ${mode} nowait`;
    // Holds one row `for update` before the step starts, so the guard waits
    // for it; reports which of the other rows the waiting step already holds.
    const whileWaiting = async (
      held: Name,
      mustBeLocked: readonly Name[],
      mustBeFree: readonly Name[],
    ) => {
      const holder = await f.pgDatabase.connect();
      const prober = await f.pgDatabase.connect();
      let pending: Promise<StepOutcome> | undefined;
      try {
        await holder.query("begin");
        await holder.query(
          `select id from ${rows[held].table} where id = $1 for update`,
          [rows[held].id],
        );
        const { pid } = (await holder.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        )).rows[0];
        pending = runStreamStep(
          dependenciesOf(f),
          issuesCheckpoint.id,
          new AbortController().signal,
        );
        await waitUntil(
          async () =>
            (await prober.query<{ n: number }>(
              `select count(*)::int as n from pg_locks as l
                where not l.granted and $1::int = any(pg_blocking_pids(l.pid))`,
              [pid],
            )).rows[0].n > 0,
          `the guard to wait for the ${held} row`,
        );
        for (const name of mustBeLocked) {
          const refused = await assertRejects(() =>
            prober.query(probe(name, "update"), [rows[name].id])
          );
          assertEquals(
            (refused as { code?: string }).code,
            "55P03",
            `the ${name} row is locked while the guard waits for the ${held}`,
          );
          // A share lock, not an exclusive one: another share lock is granted.
          const shared = await prober.query(probe(name, "share"), [
            rows[name].id,
          ]);
          assertEquals(
            shared.rowCount,
            1,
            `the ${name} row is share-locked, not exclusively locked`,
          );
        }
        for (const name of mustBeFree) {
          const free = await prober.query(probe(name, "update"), [
            rows[name].id,
          ]);
          assertEquals(
            free.rowCount,
            1,
            `the ${name} row is free while the guard waits for the ${held}`,
          );
        }
        await holder.query("commit");
        const outcome = await pending;
        assertEquals(
          [outcome.kind, outcome.kind === "stepped" ? outcome.code : null],
          ["stepped", "completed"],
        );
      } finally {
        await holder.query("rollback").catch(() => undefined);
        await pending?.catch(() => undefined);
        holder.release();
        prober.release();
      }
    };
    // Waiting on the installation nothing else is held; waiting on the
    // connection the installation is; waiting on the resource both are.
    await whileWaiting("installation", [], ["connection", "resource"]);
    await whileWaiting("connection", ["installation"], ["resource"]);
    await whileWaiting("resource", ["installation", "connection"], []);
    // The guard has all three rows when the write after it has to wait, here
    // for the checkpoint row: each is share-locked, the resource included
    // (a `for update` on it would refuse the share probe).
    await whileWaiting(
      "checkpoint",
      ["installation", "connection", "resource"],
      [],
    );
  });
});

Deno.test("issue 71 sweep: a checkpoint is not claimable between two requests of the step that holds it, in every stream", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      const heads = new Map([[1, SHA_A], [2, SHA_B]]);
      await trackPullRequests(s, seed, [1, 2], heads);
      f.github.seedIssues(s.repositoryId, spaced(120));
      for (const [number, head] of heads) {
        f.github.seedPullRequest(s.repositoryId, { number, headSha: head });
        f.github.seedCheckRuns(s.repositoryId, head, [{}]);
      }
      await ensureCheckpoints(f.runtimePgDatabase!);
      for (const stream of ["issues", "pull_requests", "checks"] as const) {
        const row = await checkpointOf(s, stream);
        const others = await otherStreams(f, stream);
        const seen: { claimed?: string | null; wait?: number } = {};
        // Before the second request the step has committed its first page or
        // row and still works on the checkpoint, from a second session's view.
        const github = disturbed(
          f,
          atRead(2, async () => {
            seen.claimed =
              (await claimDueCheckpoint(f.runtimePgDatabase!, others))?.id ??
                null;
            seen.wait = await secondsUntilDue(f, row.id);
          }),
        );
        const outcome = stepped(
          await runStep(s, stream, dependenciesOf(f, github)),
        );
        assertEquals([outcome.status, outcome.code], ["idle", "completed"]);
        assertEquals(
          seen.claimed,
          null,
          `${stream}: nothing is claimable between two requests`,
        );
        assert(
          seen.wait! > 595 && seen.wait! <= 600,
          `${stream}: the step holds the ten-minute lease, not ${seen.wait} s`,
        );
      }
    } finally {
      await removeSeed(f, seed);
    }
  });
});

// ------------------------------------------------------------ failed claims

/** The ids of every checkpoint of the fixture except those of `stream`. */
async function otherStreams(
  f: GitHubAppFixture,
  stream: SyncStream,
): Promise<string[]> {
  return (await checkpointRows(f)).filter((row) => row.stream !== stream)
    .map((row) => row.id);
}

Deno.test("issue 71 sweep: an abort during a request gives the lease back, so the checkpoint is due again in five minutes with the committed page kept", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(120));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const others = await otherStreams(f, "issues");
    const claimed = await claimDueCheckpoint(f.runtimePgDatabase!, others);
    assertEquals(claimed?.stream, "issues");
    const leased = await secondsUntilDue(f, claimed!.id);
    assert(
      leased > 595 && leased <= 600,
      `the claim leases ten minutes: ${leased} s`,
    );

    const aborted = new AbortController();
    const github = disturbed(
      f,
      atRead(2, () => {
        aborted.abort(new Error("injected shutdown"));
        return Promise.reject(new Error("injected read failure"));
      }),
    );
    await assertRejects(
      () =>
        runStreamStep(dependenciesOf(f, github), claimed!.id, aborted.signal),
      Error,
      "injected shutdown",
    );

    // The first page was committed; the failure released the lease for five
    // minutes (not the ten left of it), keeping the cursor and the counts.
    const row = await checkpointOf(s, "issues");
    assertEquals(
      [row.status, row.outcome_code, row.pages_read, row.generation],
      ["partial", "provider_error", 1, 1],
    );
    assertEquals(row.cursor?.edge, fakeTimestamp(T0 + 49 * 10_000));
    assertEquals(row.cursor?.k, 1);
    assertEquals(
      row.version,
      claimed!.version + 2,
      "one version for the page, one for the release",
    );
    assertEquals(numbersOf(await factRows(f)), range(1, 50));
    const wait = await secondsUntilDue(f, row.id);
    assert(wait > 295 && wait <= 300, `due in five minutes, not ${wait} s`);
    assertEquals(await claimDueCheckpoint(f.runtimePgDatabase!, others), null);

    // The five minutes pass: the checkpoint is claimable, cursor intact, and finishes.
    await makeDue(f, row.id);
    const again = await claimDueCheckpoint(f.runtimePgDatabase!, others);
    assertEquals(
      [again?.id, again?.status, again?.pagesRead],
      [row.id, "partial", 1],
    );
    assertEquals((again?.cursor as { edge: string }).edge, row.cursor?.edge);
    const finished = stepped(
      await runStreamStep(
        dependenciesOf(f),
        row.id,
        new AbortController().signal,
      ),
    );
    assertEquals([finished.status, finished.code], ["idle", "completed"]);
    assertEquals(numbersOf(await factRows(f)), range(1, 120));
  });
});

Deno.test("issue 71 sweep: the database failing while the step parks its checkpoint gives the lease back, and the scan completes at the next step", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const before = await checkpointOf(s, "issues");
    // Connection 1 reads the authority; 2 would store the page and 3 would
    // record the failure. Both are refused; the release goes through the pool.
    const failing = {
      ...dependenciesOf(f),
      database: flakyDatabase(f.runtimePgDatabase!, [2, 3]),
    };
    await assertRejects(
      () => runStep(s, "issues", failing),
      Error,
      "injected connection failure",
    );
    const row = await checkpointOf(s, "issues");
    assertEquals(
      [
        row.status,
        row.outcome_code,
        row.cursor,
        row.pages_read,
        row.generation,
      ],
      ["idle", "provider_error", null, 0, 1],
    );
    assertEquals(row.version, before.version + 1);
    assertEquals(await factRows(f), []);
    const wait = await secondsUntilDue(f, row.id);
    assert(wait > 295 && wait <= 300, `due in five minutes, not ${wait} s`);

    await makeDue(f, row.id);
    const retried = await step(s, "issues");
    assertEquals([retried.status, retried.code], ["idle", "completed"]);
    assertEquals(numbersOf(await factRows(f)), [1, 2, 3]);
  });
});

Deno.test("issue 71 sweep: releasing a failed claim leaves a checkpoint another worker took over alone", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    f.github.seedIssues(s.repositoryId, spaced(3));
    await ensureCheckpoints(f.runtimePgDatabase!);
    const row = await checkpointOf(s, "issues");
    const aborted = new AbortController();
    const github = disturbed(
      f,
      once(async () => {
        // The taker claims the expired lease (a new version and its own lease) and is still working.
        await f.pgDatabase.query(
          `update bakery.integration_sync_checkpoints
              set version = version + 1,
                  not_before = now() + interval '10 minutes'
            where id = $1`,
          [row.id],
        );
        aborted.abort(new Error("injected shutdown"));
        throw new Error("injected read failure");
      }),
    );
    await assertRejects(
      () => runStreamStep(dependenciesOf(f, github), row.id, aborted.signal),
      Error,
      "injected shutdown",
    );
    const after = await checkpointOf(s, "issues");
    assertEquals(
      [after.version, after.outcome_code],
      [row.version + 1, null],
      "the taker's version and outcome are untouched",
    );
    const wait = await secondsUntilDue(f, row.id);
    assert(wait > 595 && wait <= 600, `the taker keeps its lease: ${wait} s`);
  });
});

Deno.test("issue 71 sweep: a step whose lease was taken over writes nothing in any stream", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [7], new Map([[7, SHA_A]]));
      f.github.seedPullRequest(s.repositoryId, { number: 7, headSha: SHA_A });
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [{}, {}]);
      await ensureCheckpoints(f.runtimePgDatabase!);
      const registered = await pullRows(f);
      for (const stream of ["pull_requests", "checks"] as const) {
        const row = await checkpointOf(s, stream);
        const takeOver = disturbed(
          f,
          once(() =>
            f.pgDatabase.query(
              "update bakery.integration_sync_checkpoints set version = version + 1 where id = $1",
              [row.id],
            )
          ),
        );
        assertEquals(
          await runStreamStep(
            dependenciesOf(f, takeOver),
            row.id,
            new AbortController().signal,
          ),
          { kind: "skipped", reason: "superseded" },
          stream,
        );
        const after = await checkpointOf(s, stream);
        assertEquals(
          [after.status, after.outcome_code, after.cursor, after.pages_read],
          [row.status, null, row.cursor, row.pages_read],
          `${stream}: the taker's checkpoint is as the taker left it`,
        );
        assertEquals(after.version, row.version + 1, stream);
      }
      assertEquals(
        await pullRows(f),
        registered,
        "the pull request was not observed",
      );
      assertEquals(
        await factRows(f, "check_run"),
        [],
        "no check run was stored",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});

// ------------------------------------------------------- structural properties

Deno.test("issue 71 sweep: every provider request is timed before it is sent and holds no database connection, in all three streams", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      await trackPullRequests(s, seed, [100], new Map([[100, SHA_A]]));
      f.github.seedIssues(s.repositoryId, spaced(60));
      f.github.seedPullRequest(s.repositoryId, {
        number: 100,
        headSha: SHA_A,
        // After every issue, so the first page holds issues 1 to 50.
        updatedAt: fakeTimestamp(T0 + 600_000),
      });
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [
        { name: "build", startedAt: fakeTimestamp(T0 - 60_000) },
      ]);
      const pool = f.runtimePgDatabase!;
      const held = () => pool.totalCount - pool.idleCount;
      const reads: { read: Read; at: number; held: number }[] = [];
      const github = disturbed(f, async (read) => {
        reads.push({ read, at: Date.now(), held: held() });
        // Time passes inside the call, so a clock taken after it differs from one taken before.
        await sleep(30);
      });
      // Every request GitHub receives, tokens included, not only the reads.
      const requests: { path: string; held: number }[] = [];
      f.github.hooks.beforeResponse = (request) => {
        requests.push({ path: new URL(request.url).pathname, held: held() });
        return Promise.resolve();
      };
      const startedAt = Date.now();
      try {
        for (const stream of ["issues", "pull_requests", "checks"] as const) {
          const outcome = stepped(
            await runStep(s, stream, dependenciesOf(f, github)),
          );
          assertEquals(outcome.code, "completed", stream);
        }
      } finally {
        f.github.hooks.beforeResponse = null;
      }
      assertEquals(reads.map(({ read }) => read), [
        "listRepositoryIssues",
        "listRepositoryIssues",
        "readPullRequest",
        "listCheckRuns",
      ]);
      assertEquals(
        reads.map((read) => read.held),
        [0, 0, 0, 0],
        "no transaction or pooled connection is held across a provider call",
      );
      assert(
        requests.length >= 4 &&
          requests.some(({ path }) => path.endsWith("/access_tokens")),
        "the token mint and the four reads reached GitHub",
      );
      assertEquals(
        requests.filter((request) => request.held !== 0),
        [],
        "nor across any request to GitHub",
      );

      const issues = await factRows(f);
      const stamp = (number: number) =>
        issues.find((fact) => fact.number === number)!.observed_started_at
          .getTime();
      // Page one stored issues 1 to 50, page two 51 to 60 and read 50 again,
      // which only moves its read clock up to the second request.
      assert(stamp(1) <= reads[0].at && stamp(49) <= reads[0].at);
      for (const number of [50, 55]) {
        assert(
          stamp(number) > reads[0].at && stamp(number) <= reads[1].at,
          `issue ${number} was timed at the second request, not the scan's start`,
        );
      }
      const pull = (await f.pgDatabase.query<{ observed_started_at: Date }>(
        "select observed_started_at from bakery.pull_requests where provider_number = 100",
      )).rows[0].observed_started_at.getTime();
      const run = (await factRows(f, "check_run"))[0].observed_started_at
        .getTime();
      const stamps: [string, number, number][] = [
        ["first issue page", stamp(1), reads[0].at],
        ["second issue page", stamp(55), reads[1].at],
        ["pull request", pull, reads[2].at],
        ["check run", run, reads[3].at],
      ];
      for (const [name, stored, calledAt] of stamps) {
        assert(
          stored <= calledAt,
          `the ${name} read clock (${stored}) is taken before the call at ${calledAt}`,
        );
        assert(
          stored >= startedAt,
          `the ${name} read clock is the time of this read, not an older one`,
        );
      }
    } finally {
      await removeSeed(f, seed);
    }
  });
});

Deno.test("issue 71 sweep: a check run for another commit and a pull request that answers another number are never stored", async () => {
  await withFixture(async (f) => {
    const s = await subjectOf(f);
    const seed = await seedTaskAndRepository(f, s.resource);
    try {
      // Both pull requests are tracked, so a misplaced answer would find a row to land in.
      await trackPullRequests(
        s,
        seed,
        [7, 8],
        new Map([[7, SHA_A], [8, SHA_B]]),
      );
      f.github.seedPullRequest(s.repositoryId, { number: 7, headSha: SHA_A });
      f.github.seedPullRequest(s.repositoryId, { number: 8, headSha: SHA_B });
      f.github.seedCheckRuns(s.repositoryId, SHA_A, [{ name: "build" }]);
      f.github.seedCheckRuns(s.repositoryId, SHA_B, []);
      const byNumber = async () =>
        (await pullRows(f)).sort((left, right) =>
          left.provider_number - right.provider_number
        );
      const [was7, was8] = await byNumber();
      const client = f.github.client;
      const github: GitHubAppClient = {
        ...client,
        listCheckRuns: async (request, signal) => {
          const page = await client.listCheckRuns(request, signal);
          if (request.headSha !== SHA_A) return page;
          const [first] = page.checkRuns;
          return {
            ...page,
            checkRuns: [...page.checkRuns, {
              ...first,
              id: first.id + 1_000_000,
              name: "other-commit",
              headSha: SHA_B,
            }],
          };
        },
        readPullRequest: async (request, signal) => {
          const read = await client.readPullRequest(request, signal);
          // GitHub answers for pull request 7 with the body of number 8.
          return request.number === 7 && !("kind" in read)
            ? { ...read, number: 8 }
            : read;
        },
      };

      const checks = stepped(
        await runStep(s, "checks", dependenciesOf(f, github)),
      );
      assertEquals([checks.status, checks.code], ["idle", "completed"]);
      assertEquals([checks.tally.written, checks.tally.skipped], [1, 1]);
      const runs = await factRows(f, "check_run");
      assertEquals(runs.map(({ summary }) => summary.name), ["build"]);
      assertEquals(runs.map(({ head_sha }) => head_sha), [SHA_A]);

      const pulls = stepped(
        await runStep(s, "pull_requests", dependenciesOf(f, github)),
      );
      assertEquals([pulls.status, pulls.code], ["idle", "completed"]);
      assertEquals(
        [pulls.tally.written, pulls.tally.skipped],
        [1, 1],
        "pull request 8 was read and stored, pull request 7's answer was skipped",
      );
      const [seven, eight] = await byNumber();
      assertEquals(seven, was7, "pull request 7 was not observed");
      assertEquals(
        [eight.head_sha, eight.provider_updated_at === null],
        [SHA_B, false],
        "pull request 8 holds its own read, not the other answer",
      );
      assertNotEquals(eight.version, was8.version);
      assertEquals(
        (await checkpointOf(s, "pull_requests")).cursor,
        { after: null },
        "the rotation still moved on",
      );
    } finally {
      await removeSeed(f, seed);
    }
  });
});
