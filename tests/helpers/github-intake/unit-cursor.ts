import { assert, assertEquals } from "@std/assert";
import {
  advanceIssueCursor,
  formatGitHubTime,
  initialIssueCursor,
  ISSUE_PAGE_SIZE,
  type IssueCursor,
  type IssueRequest,
  issueRequest,
  readIssueCursor,
  readKeysetCursor,
  rescanIssueCursor,
  startIssueRun,
} from "../../../apps/server/src/modules/integrations/sync-checkpoints.ts";

/**
 * Issue 71 sweep: the issue cursor against a pure model of GitHub's issue
 * list. The model sorts by `updated_at` then arrival, pages at 50, filters by
 * `since` inclusively or exclusively, and an edit moves an issue to the end
 * with a later `updated_at`, as GitHub does.
 */

const SECOND = 1000;
const BASE = Date.parse("2026-10-30T00:00:00Z");
/** Seconds after BASE. */
const at = (seconds: number) => BASE + seconds * SECOND;
const SINCE_MODES = ["inclusive", "exclusive"] as const;
type SinceMode = (typeof SINCE_MODES)[number];

type ModelIssue = {
  id: number;
  updated: number;
  sequence: number;
  state: "open" | "closed";
};

/** What a model answers for one list request. */
type ModelPage = {
  items: { id: number; updatedAt: string }[];
  hasNext: boolean;
};

class ListModel {
  readonly issues = new Map<number, ModelIssue>();
  #sequence = 0;
  #nextId = 1;
  readonly sinceMode: SinceMode;
  constructor(sinceMode: SinceMode) {
    this.sinceMode = sinceMode;
  }

  /** Adds `count` issues updated at `updated` (ms); returns their ids. */
  add(count: number, updated: number, state: "open" | "closed" = "open") {
    const ids: number[] = [];
    for (let index = 0; index < count; index++) {
      const issue: ModelIssue = {
        id: this.#nextId++,
        updated,
        sequence: ++this.#sequence,
        state,
      };
      this.issues.set(issue.id, issue);
      ids.push(issue.id);
    }
    return ids;
  }

  latest(): number {
    let latest = 0;
    for (const issue of this.issues.values()) {
      latest = Math.max(latest, issue.updated);
    }
    return latest;
  }

  /** The state and `since` filter of a request, before paging. */
  matches(issue: ModelIssue, request: IssueRequest): boolean {
    if (request.state === "open" && issue.state !== "open") return false;
    if (request.since === null) return true;
    const since = Date.parse(request.since);
    return this.sinceMode === "inclusive"
      ? issue.updated >= since
      : issue.updated > since;
  }

  visible(request: IssueRequest): ModelIssue[] {
    return [...this.issues.values()].filter((issue) =>
      this.matches(issue, request)
    ).sort((left, right) =>
      left.updated - right.updated || left.sequence - right.sequence
    );
  }

  list(request: IssueRequest): ModelPage {
    const all = this.visible(request);
    const start = (request.page - 1) * ISSUE_PAGE_SIZE;
    return {
      items: all.slice(start, start + ISSUE_PAGE_SIZE).map((issue) => ({
        id: issue.id,
        updatedAt: formatGitHubTime(issue.updated),
      })),
      hasNext: request.page * ISSUE_PAGE_SIZE < all.length,
    };
  }

  /**
   * An edit or close: GitHub bumps `updated_at` (never below the latest in
   * the repository) and the issue moves to the end of the ascending order.
   */
  edit(id: number, options: { close?: boolean; to?: number } = {}): void {
    const issue = this.issues.get(id);
    assert(issue !== undefined, `issue ${id} exists`);
    issue.updated = Math.max(this.latest(), options.to ?? 0);
    issue.sequence = ++this.#sequence;
    if (options.close) issue.state = "closed";
  }
}

// Mulberry32: a small seeded PRNG, so a failing seed replays exactly.
type Random = () => number;
function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (random: Random, low: number, high: number) =>
  low + Math.floor(random() * (high - low + 1));

type ScheduledEdit = {
  /** The edit lands in the gap before this request (2 is the first gap). */
  before: number;
  id: number;
  close?: boolean;
  to?: number;
};

type ScanOptions = {
  random?: Random;
  editChance?: number;
  maxEdits?: number;
  scheduled?: readonly ScheduledEdit[];
};

type ScanResult = {
  requests: IssueRequest[];
  cursors: IssueCursor[];
  observed: Set<number>;
  edited: Set<number>;
  /** Edits of a read, in-window issue made before a request with page above 1. */
  qualifying: number;
  /** Issues the first request's filter showed and the scan never edited. */
  expected: Set<number>;
  cursor: IssueCursor;
};

const HARD_LIMIT = 5000;

/** Runs one scan to completion against the model. */
function scan(
  model: ListModel,
  start: IssueCursor,
  options: ScanOptions = {},
): ScanResult {
  let cursor = start;
  const requests: IssueRequest[] = [];
  const cursors: IssueCursor[] = [start];
  const observed = new Set<number>();
  const edited = new Set<number>();
  const expected = new Set(
    model.visible(issueRequest(start)).map(({ id }) => id),
  );
  let qualifying = 0;
  let edits = 0;
  const edit = (id: number, close: boolean, to: number | undefined) => {
    const issue = model.issues.get(id)!;
    const next = issueRequest(cursor);
    // The shift happens only for an issue the next request would have listed,
    // that the scan already read, ahead of a request with an offset.
    if (next.page > 1 && observed.has(id) && model.matches(issue, next)) {
      qualifying += 1;
    }
    model.edit(id, { close, to });
    edited.add(id);
    edits += 1;
  };
  for (let number = 1; number <= HARD_LIMIT; number++) {
    if (number >= 2) {
      for (const scheduled of options.scheduled ?? []) {
        if (scheduled.before === number) {
          edit(scheduled.id, scheduled.close ?? false, scheduled.to);
        }
      }
      const random = options.random;
      if (
        random !== undefined && edits < (options.maxEdits ?? 0) &&
        random() < (options.editChance ?? 0) && model.issues.size > 0
      ) {
        const ids = [...model.issues.keys()];
        edit(
          ids[between(random, 0, ids.length - 1)],
          random() < 0.5,
          undefined,
        );
      }
    }
    const request = issueRequest(cursor);
    requests.push(request);
    const page = model.list(request);
    for (const item of page.items) observed.add(item.id);
    const advance = advanceIssueCursor(cursor, page);
    cursor = advance.cursor;
    cursors.push(cursor);
    if (advance.completed) {
      return {
        requests,
        cursors,
        observed,
        edited,
        qualifying,
        expected,
        cursor,
      };
    }
  }
  throw new Error(`the scan did not complete within ${HARD_LIMIT} requests`);
}

/** The ids the scan was owed and never saw. */
function lost(result: ScanResult): number[] {
  return [...result.expected].filter((id) =>
    !result.edited.has(id) && !result.observed.has(id)
  ).sort((left, right) => left - right);
}

/** Every request completes, strictly raises the edge, or raises the offset. */
function assertProgress(result: ScanResult, label: string): void {
  for (let index = 1; index < result.cursors.length; index++) {
    const before = result.cursors[index - 1];
    const after = result.cursors[index];
    const completed = index === result.cursors.length - 1;
    if (completed) continue;
    const edgeBefore = before.edge === null
      ? -Infinity
      : Date.parse(before.edge);
    const edgeAfter = after.edge === null ? -Infinity : Date.parse(after.edge);
    assert(edgeAfter >= edgeBefore, `${label}: the edge never decreases`);
    assert(
      edgeAfter > edgeBefore || after.k > before.k,
      `${label}: request ${index} neither raised the edge nor the offset`,
    );
    if (edgeAfter > edgeBefore) {
      assertEquals(
        after.k,
        1,
        `${label}: an advancing edge restarts at page 1`,
      );
    }
  }
}

function assertScan(result: ScanResult, label: string): void {
  assertProgress(result, label);
  assertEquals(
    result.cursor.edge,
    null,
    `${label}: completion resets the edge`,
  );
  assertEquals(result.cursor.k, 1, `${label}: completion resets the offset`);
  assertEquals(
    result.cursor.initial,
    false,
    `${label}: no scan is initial twice`,
  );
  const missing = lost(result);
  if (result.qualifying === 0) {
    assertEquals(
      missing,
      [],
      `${label}: with no edit of a read, in-window issue before an offset request, every unedited issue is observed`,
    );
  } else {
    assert(
      missing.length <= result.qualifying,
      `${label}: ${missing.length} issues lost for ${result.qualifying} qualifying edits`,
    );
  }
}

/** Bound on the requests of a scan: distinct seconds, pages, and edits. */
function requestBound(model: ListModel, edits: number): number {
  const seconds = new Set([...model.issues.values()].map((i) => i.updated));
  return 3 * (seconds.size + edits) +
    Math.ceil(model.issues.size / ISSUE_PAGE_SIZE) + 5;
}

const RUN_START = new Date(at(5000));

// ------------------------------------------------------------- pure rules

Deno.test("issue 71 cursor: the first request of the initial scan lists open issues and sends no since", () => {
  const cursor = initialIssueCursor(RUN_START);
  assertEquals(cursor, {
    initial: true,
    runStartedAt: formatGitHubTime(RUN_START.getTime()),
    edge: null,
    k: 1,
    highWater: null,
  });
  assertEquals(issueRequest(cursor), { state: "open", since: null, page: 1 });
});

Deno.test("issue 71 cursor: once the edge is set every request sends since one second before it, at the current offset", () => {
  const first = advanceIssueCursor(initialIssueCursor(RUN_START), {
    items: [{ updatedAt: "2026-10-30T10:00:00Z" }],
    hasNext: true,
  });
  assertEquals(first.completed, false);
  // A null edge counts as advanced: the edge is the page's latest, page 1.
  assertEquals(first.cursor.edge, "2026-10-30T10:00:00Z");
  assertEquals(first.cursor.k, 1);
  assertEquals(issueRequest(first.cursor), {
    state: "open",
    since: "2026-10-30T09:59:59Z",
    page: 1,
  });
  // A full page with nothing later than the edge is a walk: the offset moves.
  const walk = advanceIssueCursor(first.cursor, {
    items: [{ updatedAt: "2026-10-30T10:00:00Z" }],
    hasNext: true,
  });
  assertEquals(walk.cursor.edge, "2026-10-30T10:00:00Z");
  assertEquals(walk.cursor.k, 2);
  assertEquals(issueRequest(walk.cursor).since, "2026-10-30T09:59:59Z");
  // A page that shows a later item advances the edge and goes back to page 1.
  const advanced = advanceIssueCursor(walk.cursor, {
    items: [
      { updatedAt: "2026-10-30T10:00:00Z" },
      { updatedAt: "2026-10-30T10:00:03Z" },
    ],
    hasNext: true,
  });
  assertEquals(advanced.cursor.edge, "2026-10-30T10:00:03Z");
  assertEquals(advanced.cursor.k, 1);
  // The edge never moves back: a page of older items keeps it.
  const older = advanceIssueCursor(advanced.cursor, {
    items: [{ updatedAt: "2026-10-30T10:00:01Z" }],
    hasNext: true,
  });
  assertEquals(older.cursor.edge, "2026-10-30T10:00:03Z");
  assertEquals(older.cursor.k, 2);
});

Deno.test("issue 71 cursor: an empty page ends the scan whatever the link said, so a server cannot hold it open", () => {
  const cursor = {
    ...initialIssueCursor(RUN_START),
    edge: "2026-10-30T10:00:00Z",
    k: 4,
  };
  const result = advanceIssueCursor(cursor, { items: [], hasNext: true });
  assertEquals(result.completed, true);
  assertEquals(result.cursor.k, 1);
  assertEquals(result.cursor.edge, null);
});

Deno.test("issue 71 cursor: completion resets the edge and offset, ends the initial scan and starts the next from the high-water mark minus 60 seconds", () => {
  // The initial scan lists open issues only and sees no closure, so its mark
  // is the scan's start minus 60 seconds, not the latest update it read.
  const initial = {
    ...initialIssueCursor(RUN_START),
    edge: formatGitHubTime(at(5000)),
    k: 3,
  };
  const done = advanceIssueCursor(initial, {
    items: [{ updatedAt: formatGitHubTime(at(4990)) }],
    hasNext: false,
  });
  assertEquals(done.completed, true);
  assertEquals(done.cursor, {
    initial: false,
    runStartedAt: initial.runStartedAt,
    edge: null,
    k: 1,
    highWater: formatGitHubTime(at(5000) - 60 * SECOND),
  });
  assertEquals(issueRequest(done.cursor), {
    state: "all",
    since: formatGitHubTime(at(5000) - 120 * SECOND),
    page: 1,
  });

  // An incremental scan's mark is the latest of itself, its edge and its last page.
  const incremental = startIssueRun(done.cursor, new Date(at(6000)));
  assertEquals(incremental.edge, null);
  assertEquals(incremental.k, 1);
  assertEquals(incremental.initial, false);
  assertEquals(incremental.highWater, done.cursor.highWater);
  const finished = advanceIssueCursor({
    ...incremental,
    edge: formatGitHubTime(at(5500)),
    k: 2,
  }, {
    items: [{ updatedAt: formatGitHubTime(at(5600)) }],
    hasNext: false,
  });
  assertEquals(finished.cursor.highWater, formatGitHubTime(at(5600)));
  const quiet = advanceIssueCursor(incremental, { items: [], hasNext: false });
  assertEquals(quiet.cursor.highWater, done.cursor.highWater);
});

Deno.test("issue 71 cursor: an incremental scan stopped mid-way and started again forgets its edge and offset, keeps the mark and starts now", () => {
  // A blocked checkpoint armed again hands the old cursor over: edge set,
  // offset above one.
  const stopped: IssueCursor = {
    initial: false,
    runStartedAt: formatGitHubTime(at(4000)),
    edge: formatGitHubTime(at(4500)),
    k: 3,
    highWater: formatGitHubTime(at(3000)),
  };
  const copy = structuredClone(stopped);
  const started = startIssueRun(stopped, new Date(at(6000)));
  assertEquals(started, {
    initial: false,
    runStartedAt: formatGitHubTime(at(6000)),
    edge: null,
    k: 1,
    highWater: stopped.highWater,
  });
  assertEquals(stopped, copy, "the stopped cursor is not changed");
  // The first request starts over: page 1, 60 seconds before the mark, so
  // everything the stopped attempt read is read again and nothing is lost.
  assertEquals(issueRequest(started), {
    state: "all",
    since: formatGitHubTime(at(3000) - 60 * SECOND),
    page: 1,
  });
  // The mark moves only when a scan completes: a quiet restart keeps it.
  const quiet = advanceIssueCursor(started, { items: [], hasNext: false });
  assertEquals(quiet.cursor.highWater, stopped.highWater);
});

Deno.test("issue 71 cursor: an initial backfill stopped after a page and started again keeps its first start, forgets its edge and offset and still lists open issues from the beginning", () => {
  // The first attempt stored open-only pages; a blocked checkpoint armed
  // again hands its cursor over with the edge set and an offset above one.
  const stopped: IssueCursor = {
    initial: true,
    runStartedAt: formatGitHubTime(at(4000)),
    edge: formatGitHubTime(at(4500)),
    k: 3,
    highWater: null,
  };
  const copy = structuredClone(stopped);
  const started = startIssueRun(stopped, new Date(at(6000)));
  assertEquals(started, {
    initial: true,
    runStartedAt: formatGitHubTime(at(4000)),
    edge: null,
    k: 1,
    highWater: null,
  });
  assertEquals(stopped, copy, "the stopped cursor is not changed");
  assertEquals(issueRequest(started), {
    state: "open",
    since: null,
    page: 1,
  });
  // Completion sets the mark from the first attempt's start, so the next scan
  // covers every change since the backfill began, not since the restart.
  const done = advanceIssueCursor(started, { items: [], hasNext: false });
  assertEquals(done.cursor.highWater, formatGitHubTime(at(4000) - 60 * SECOND));
  assertEquals(issueRequest(done.cursor), {
    state: "all",
    since: formatGitHubTime(at(4000) - 120 * SECOND),
    page: 1,
  });
});

Deno.test("issue 71 cursor: an initial backfill that stored nothing starts now, because no page set its edge", () => {
  // Blocked before its first page: the stored cursor holds no edge, so there
  // is no stored fact for the restart to correct and a fresh start is right.
  const blocked: IssueCursor = {
    ...initialIssueCursor(new Date(at(4000))),
    edge: null,
  };
  const started = startIssueRun(blocked, new Date(at(6000)));
  assertEquals(started, {
    initial: true,
    runStartedAt: formatGitHubTime(at(6000)),
    edge: null,
    k: 1,
    highWater: null,
  });
  // A checkpoint that never ran has no stored cursor at all.
  assertEquals(
    startIssueRun(
      readIssueCursor(null, new Date(at(6000))),
      new Date(at(6000)),
    ).runStartedAt,
    formatGitHubTime(at(6000)),
  );
});

Deno.test("issue 71 cursor: a missing cursor is a backfill, an unreadable one a full rescan and a rotation cursor starts over", () => {
  assertEquals(readIssueCursor(null, RUN_START).initial, true);
  const damaged = readIssueCursor({ initial: "yes" }, RUN_START);
  assertEquals(damaged, rescanIssueCursor(RUN_START));
  assertEquals(issueRequest(damaged), { state: "all", since: null, page: 1 });
  const stored = initialIssueCursor(RUN_START);
  assertEquals(
    readIssueCursor(JSON.parse(JSON.stringify(stored)), RUN_START),
    stored,
  );
  assertEquals(readKeysetCursor({ after: null }), { after: null });
  assertEquals(readKeysetCursor("junk"), { after: null });
  assertEquals(readKeysetCursor({ after: "not-a-uuid" }), { after: null });
  const id = crypto.randomUUID();
  assertEquals(readKeysetCursor({ after: id }), { after: id });
});

// --------------------------------------------------------- model scenarios

for (const mode of SINCE_MODES) {
  Deno.test(`issue 71 cursor (${mode} since): 30 issues at S and 70 at S+1 finish in three requests and every issue is observed`, () => {
    const model = new ListModel(mode);
    model.add(30, at(10));
    model.add(70, at(11));
    const result = scan(model, initialIssueCursor(RUN_START));
    assertEquals(result.requests.length, 3);
    assertEquals(result.observed.size, 100);
    assertEquals(lost(result), []);
    assertScan(result, `stall ${mode}`);
    // The scan resets: edge null, offset 1, the mark one minute before its start.
    assertEquals(result.cursor, {
      initial: false,
      runStartedAt: formatGitHubTime(RUN_START.getTime()),
      edge: null,
      k: 1,
      highWater: formatGitHubTime(RUN_START.getTime() - 60 * SECOND),
    });
  });

  Deno.test(`issue 71 cursor (${mode} since): a boundary that falls exactly on a page end loses nothing`, () => {
    const model = new ListModel(mode);
    model.add(50, at(10));
    model.add(50, at(11));
    const result = scan(model, initialIssueCursor(RUN_START));
    assertEquals(result.requests.length, 3);
    assertEquals(result.observed.size, 100);
    assertScan(result, `page end ${mode}`);
    // Exactly one page of one second is a single request.
    const single = new ListModel(mode);
    single.add(50, at(10));
    const one = scan(single, initialIssueCursor(RUN_START));
    assertEquals(one.requests.length, 1);
    assertEquals(one.observed.size, 50);
  });

  Deno.test(`issue 71 cursor (${mode} since): N issues in one second take one request up to 50 and 1 + ceil(N / 50) above`, () => {
    for (const count of [0, 1, 49, 50, 51, 99, 100, 101, 120, 150, 251]) {
      const model = new ListModel(mode);
      if (count > 0) model.add(count, at(10));
      const result = scan(model, initialIssueCursor(RUN_START));
      assertEquals(
        result.requests.length,
        count <= ISSUE_PAGE_SIZE ? 1 : 1 + Math.ceil(count / ISSUE_PAGE_SIZE),
        `N = ${count}`,
      );
      assertEquals(result.observed.size, count, `N = ${count}`);
      assertScan(result, `ties ${count} ${mode}`);
    }
  });

  Deno.test(`issue 71 cursor (${mode} since): reviewer repro, 50 issues at S and 1 at S+1 lose one unedited issue to an edit before the offset request, and a later scan whose window reaches it observes it`, () => {
    const model = new ListModel(mode);
    const ids = model.add(50, at(10));
    const [late] = model.add(1, at(11));
    // The scan has read ids[0] on pages 1 and 2 of its first two requests; the
    // edit comes before the request with page 2.
    const result = scan(model, initialIssueCursor(new Date(at(40))), {
      scheduled: [{ before: 3, id: ids[0], to: at(15) }],
    });
    assertEquals(result.requests.map(({ page }) => page), [1, 1, 2]);
    assertEquals(result.qualifying, 1);
    assertEquals(lost(result), [late]);
    assertScan(result, `repro A ${mode}`);
    // Its next webhook or any later scan whose window reaches it observes it.
    const next = scan(model, startIssueRun(result.cursor, new Date(at(60))));
    assertEquals(next.observed.has(late), true);
  });

  Deno.test(`issue 71 cursor (${mode} since): reviewer repro, 49 issues at S and 49 at S+1 under an edit before the offset request`, () => {
    const model = new ListModel(mode);
    const ids = model.add(49, at(10));
    model.add(49, at(11));
    const result = scan(model, initialIssueCursor(new Date(at(40))), {
      scheduled: [{ before: 3, id: ids[0], to: at(15) }],
    });
    if (mode === "inclusive") {
      // The second request repeats page 1, so a walk starts and the edit
      // lands before its offset request: one unedited issue is lost.
      assertEquals(result.requests.length, 3);
      assertEquals(result.qualifying, 1);
      assertEquals(lost(result).length, 1);
    } else {
      // Exclusive since drops the S issues, so the second request already
      // holds the rest on one page and no offset request exists to disturb.
      assertEquals(result.requests.length, 2);
      assertEquals(result.qualifying, 0);
      assertEquals(lost(result), []);
    }
    assertScan(result, `repro B ${mode}`);
  });

  Deno.test(`issue 71 cursor (${mode} since): an edit of a read issue before a page-1 request, even across a walk, loses nothing`, () => {
    const model = new ListModel(mode);
    // Distinct seconds: every request advances the edge and stays at page 1.
    for (let index = 0; index < 160; index++) model.add(1, at(10 + index));
    const result = scan(model, initialIssueCursor(RUN_START), {
      scheduled: [
        { before: 2, id: 3 },
        { before: 3, id: 20, close: true },
        { before: 3, id: 7 },
      ],
    });
    assert(result.requests.every(({ page }) => page === 1));
    assertEquals(result.qualifying, 0);
    assertEquals(lost(result), []);
    assertScan(result, `page one edits ${mode}`);
  });
}

// ------------------------------------------------------------ property runs

function randomModel(random: Random, mode: SinceMode): ListModel {
  const model = new ListModel(mode);
  let second = between(random, 0, 5);
  for (let cluster = between(random, 1, 7); cluster > 0; cluster--) {
    const size = [
      () => between(random, 0, 3),
      () => between(random, 20, 75),
      () => between(random, 90, 130),
    ][between(random, 0, 2)]();
    const state = random() < 0.2 ? "closed" : "open";
    for (let index = 0; index < size; index++) {
      model.add(1, at(second), random() < 0.2 ? "closed" : state);
    }
    second += between(random, 0, 3);
  }
  return model;
}

for (const mode of SINCE_MODES) {
  Deno.test(`issue 71 cursor (${mode} since): random initial scans with edits between requests terminate, observe every unedited issue, and lose at most one per qualifying edit`, () => {
    let qualifyingRuns = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed * 7919);
      const model = randomModel(random, mode);
      const result = scan(model, initialIssueCursor(RUN_START), {
        random,
        editChance: random() < 0.5 ? 0 : 0.35,
        maxEdits: between(random, 0, 4),
      });
      assertScan(result, `initial seed ${seed} ${mode}`);
      assert(
        result.requests.length <= requestBound(model, result.edited.size),
        `seed ${seed}: ${result.requests.length} requests exceed the bound`,
      );
      if (result.qualifying > 0) qualifyingRuns += 1;
    }
    assert(
      qualifyingRuns > 0,
      "the generator reaches the offset-walk edit case",
    );
  });

  Deno.test(`issue 71 cursor (${mode} since): random incremental scans cover every unedited issue updated inside their window`, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = seeded(seed * 104729);
      const model = randomModel(random, mode);
      const first = scan(model, initialIssueCursor(RUN_START));
      assertScan(first, `first ${seed} ${mode}`);
      // Time passes; issues change, close and arrive in clusters.
      const later = RUN_START.getTime() + 30 * SECOND;
      let clock = later;
      for (let wave = between(random, 1, 4); wave > 0; wave--) {
        const count = [
          () => between(random, 0, 3),
          () => between(random, 30, 120),
        ][
          between(random, 0, 1)
        ]();
        for (let index = 0; index < count; index++) {
          if (model.issues.size > 0 && random() < 0.6) {
            const ids = [...model.issues.keys()];
            model.edit(ids[between(random, 0, ids.length - 1)], {
              close: random() < 0.3,
              to: clock,
            });
          } else {
            model.add(1, clock);
          }
        }
        clock += between(random, 0, 2) * SECOND;
      }
      const second = scan(
        model,
        startIssueRun(first.cursor, new Date(clock)),
        {
          random,
          editChance: random() < 0.5 ? 0 : 0.35,
          maxEdits: between(random, 0, 4),
        },
      );
      assertScan(second, `incremental ${seed} ${mode}`);
      assertEquals(second.requests[0].state, "all");
      assertEquals(
        second.requests[0].since,
        formatGitHubTime(RUN_START.getTime() - 120 * SECOND),
        "the first incremental request starts two minutes before the backfill began",
      );
      assert(
        second.requests.length <= requestBound(model, second.edited.size),
        `seed ${seed}: ${second.requests.length} requests exceed the bound`,
      );
    }
  });
}

Deno.test("issue 71 cursor: a stale open issue closed during the initial scan is listed by the first incremental scan", () => {
  for (const mode of SINCE_MODES) {
    const model = new ListModel(mode);
    const [watched] = model.add(1, at(10));
    for (let index = 0; index < 120; index++) model.add(1, at(20 + index));
    // The initial scan reads the watched issue on page 1, then GitHub closes it
    // before the second request: the open-only list no longer shows it.
    const first = scan(model, initialIssueCursor(RUN_START), {
      scheduled: [{
        before: 2,
        id: watched,
        close: true,
        to: RUN_START.getTime() + 5 * SECOND,
      }],
    });
    assertEquals(first.observed.has(watched), true);
    const next = scan(model, startIssueRun(first.cursor, new Date(at(6000))));
    assertEquals(next.requests[0].state, "all");
    assertEquals(
      next.observed.has(watched),
      true,
      `${mode}: the incremental scan lists the closed issue`,
    );
  }
});

/**
 * Makes `count` requests of a scan and stops, as a checkpoint blocked between
 * two pages does; the returned cursor is what the checkpoint keeps.
 */
function stopAfter(model: ListModel, start: IssueCursor, count: number) {
  let cursor = start;
  const observed = new Set<number>();
  for (let request = 1; request <= count; request++) {
    const page = model.list(issueRequest(cursor));
    for (const item of page.items) observed.add(item.id);
    const advance = advanceIssueCursor(cursor, page);
    assert(!advance.completed, "the scan is still in progress when it stops");
    cursor = advance.cursor;
  }
  return { cursor, observed };
}

Deno.test("issue 71 cursor: an issue closed between a backfill's blocked attempt and its restart is listed by the first incremental scan", () => {
  for (const mode of SINCE_MODES) {
    const model = new ListModel(mode);
    const [watched] = model.add(1, at(10));
    for (let index = 0; index < 120; index++) model.add(1, at(20 + index));
    // The first attempt reads page 1, stores the watched issue open and is
    // blocked with the cursor it committed.
    const first = stopAfter(model, initialIssueCursor(RUN_START), 1);
    assertEquals(first.observed.has(watched), true);
    assertEquals(first.cursor.initial, true);
    assert(first.cursor.edge !== null, "the first page set the edge");
    // GitHub closes it while the checkpoint is blocked; the restart comes
    // far later than the closure.
    model.edit(watched, { close: true, to: RUN_START.getTime() + 5 * SECOND });
    const restarted = startIssueRun(first.cursor, new Date(at(6000)));
    const second = scan(model, restarted);
    assertScan(second, `restarted backfill ${mode}`);
    assertEquals(
      second.observed.has(watched),
      false,
      "the open-only list no longer shows it",
    );
    assertEquals(second.requests[0], { state: "open", since: null, page: 1 });
    // The mark comes from the first attempt's start.
    assertEquals(
      second.cursor.highWater,
      formatGitHubTime(RUN_START.getTime() - 60 * SECOND),
    );
    const next = scan(
      model,
      startIssueRun(second.cursor, new Date(at(7000))),
    );
    assertEquals(next.requests[0], {
      state: "all",
      since: formatGitHubTime(RUN_START.getTime() - 120 * SECOND),
      page: 1,
    });
    assertEquals(
      next.observed.has(watched),
      true,
      `${mode}: the incremental scan lists the closed issue`,
    );
  }
});

Deno.test("issue 71 cursor: an incremental scan blocked mid-way and started again re-reads from its mark, so a closure made between the attempts is listed by the restarted scan itself", () => {
  for (const mode of SINCE_MODES) {
    const model = new ListModel(mode);
    const [watched] = model.add(1, at(10));
    for (let index = 0; index < 120; index++) model.add(1, at(20 + index));
    const backfill = scan(model, initialIssueCursor(RUN_START));
    assertScan(backfill, `backfill ${mode}`);
    // Changes after the backfill: 120 issues updated one second apart, so the
    // incremental scan needs three pages and stops after the first.
    for (let index = 0; index < 120; index++) {
      model.edit(index + 2, {
        to: RUN_START.getTime() + (30 + index) * SECOND,
      });
    }
    const attempt = startIssueRun(backfill.cursor, new Date(at(6000)));
    const stopped = stopAfter(model, attempt, 1);
    assertEquals(stopped.observed.has(watched), false);
    assert(stopped.cursor.edge !== null, "the first page set the edge");
    assertEquals(stopped.cursor.highWater, backfill.cursor.highWater);
    // The first issue is closed after the blocked attempt stopped.
    model.edit(watched, {
      close: true,
      to: RUN_START.getTime() + 600 * SECOND,
    });
    const restarted = startIssueRun(stopped.cursor, new Date(at(6600)));
    assertEquals(restarted.highWater, backfill.cursor.highWater);
    assertEquals(
      issueRequest(restarted).since,
      formatGitHubTime(RUN_START.getTime() - 120 * SECOND),
      "the restart reads again from the mark, not from the stopped edge",
    );
    const second = scan(model, restarted);
    assertScan(second, `restarted incremental ${mode}`);
    assertEquals(
      second.observed.has(watched),
      true,
      `${mode}: the restarted scan lists the closed issue`,
    );
    for (let id = 2; id <= 121; id++) {
      assertEquals(second.observed.has(id), true, `${mode}: issue ${id}`);
    }
  }
});
