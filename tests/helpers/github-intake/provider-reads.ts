import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  createFetchGitHubAppClient,
  createGitHubAppJwt,
  GITHUB_MAX_LABEL_LENGTH,
  GITHUB_MAX_LABELS,
  type GitHubAppClient,
  type GitHubPermissions,
  GitHubReadFailure,
} from "../../../apps/server/src/modules/integrations/github-app.ts";
import {
  readJson,
  type Transport,
} from "../../../apps/server/src/modules/integrations/github-transport.ts";
import {
  createFakeGitHubApp,
  FAKE_PROVIDER_CANARY,
  fakeAppKey,
  fakeCommitSha,
  type FakeReadRoute,
  fakeRepositories,
  fakeTimestamp,
} from "../fake-github-app.ts";

/*
 * Provider lane for issue 71: the token-based GitHub reads (issue list, one
 * issue, one pull request, check runs, repository identity) against the fake
 * GitHub and against hand-built answers, so every status, size and shape the
 * client must survive is exercised without a network.
 */

const signal = () => new AbortController().signal;

const PERMISSIONS = {
  metadata: "read",
  issues: "read",
  pull_requests: "read",
  checks: "read",
} as const satisfies GitHubPermissions;

const MIB = 1_048_576;

/** A fake App with one installation of two repositories and a read token for the first. */
async function fixture(requestTimeoutMs = 500) {
  const github = createFakeGitHubApp({ requestTimeoutMs });
  const { app } = github.issueCode({ pem: fakeAppKey.pem });
  const installed = github.addInstallation(app, {
    repositories: fakeRepositories(2, ["admin"]),
  });
  const [repository, other] = installed.repositories;
  const mint = async (
    repositoryIds: number[],
    permissions: GitHubPermissions = PERMISSIONS,
  ) => {
    const minted = await github.client.mintInstallationToken({
      jwt: await createGitHubAppJwt(app.id, fakeAppKey.pem),
      installationId: installed.id,
      repositoryIds,
      permissions,
    }, signal());
    assert(minted.kind === "minted");
    return minted.token;
  };
  const nameOf = (candidate: { name: string }) =>
    `${installed.account.login}/${candidate.name}`;
  return {
    github,
    installed,
    repository,
    other,
    fullName: nameOf(repository),
    otherFullName: nameOf(other),
    nameOf,
    token: await mint([repository.id]),
    mint,
  };
}

/** A client whose every request is answered by `respond`; the request is kept. */
function clientFor(
  respond: (request: Request) => Response | Promise<Response>,
  requests: Request[] = [],
): GitHubAppClient {
  return createFetchGitHubAppClient((input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }, { requestTimeoutMs: 500 });
}

/** Everything a failure exposes to a caller that logs or serializes it. */
function surface(error: Error): string {
  return [
    error.name,
    error.message,
    error.stack ?? "",
    JSON.stringify(error),
    String(error.cause ?? ""),
  ].join("\n");
}

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const ISSUE_WIRE = {
  id: 11,
  number: 7,
  state: "open",
  state_reason: null,
  title: "Private title",
  body: "Private body",
  user: { login: "octocat" },
  labels: [],
  locked: false,
  updated_at: "2026-10-31T12:00:00Z",
};
const PULL_WIRE = {
  number: 7,
  state: "open",
  merged: false,
  merge_commit_sha: SHA,
  updated_at: "2026-10-31T12:00:00Z",
  html_url: "https://github.com/o/r/pull/7",
  head: { sha: SHA },
  base: { sha: OTHER_SHA },
  title: "Private title",
  body: "Private body",
};
const CHECK_RUN_WIRE = {
  id: 21,
  name: "ci",
  status: "completed",
  conclusion: "success",
  app: { id: 15_368, slug: "github-actions" },
  head_sha: SHA,
  started_at: "2026-10-31T11:00:00Z",
  completed_at: "2026-10-31T11:05:00Z",
};

/** Every read, with the answer it parses and the byte cap its answer has. */
type Read = {
  name: string;
  call: (
    client: GitHubAppClient,
    token: string,
    fullName: string,
  ) => Promise<unknown>;
  valid: () => Response;
  /** A valid answer carrying `extra` more bytes of dropped text. */
  padded: (extra: number) => Response;
  cap: number;
};
const READS: Read[] = [
  {
    name: "listRepositoryIssues",
    call: (client, token, fullName) =>
      client.listRepositoryIssues(
        { token, fullName, state: "open", page: 1 },
        signal(),
      ),
    valid: () => Response.json([ISSUE_WIRE]),
    padded: (extra) =>
      Response.json([{ ...ISSUE_WIRE, body: "x".repeat(extra) }]),
    cap: 4 * MIB,
  },
  {
    name: "readIssue",
    call: (client, token, fullName) =>
      client.readIssue({ token, fullName, number: 7 }, signal()),
    valid: () => Response.json(ISSUE_WIRE),
    padded: (extra) =>
      Response.json({ ...ISSUE_WIRE, body: "x".repeat(extra) }),
    cap: MIB,
  },
  {
    name: "readPullRequest",
    call: (client, token, fullName) =>
      client.readPullRequest({ token, fullName, number: 7 }, signal()),
    valid: () => Response.json(PULL_WIRE),
    padded: (extra) => Response.json({ ...PULL_WIRE, body: "x".repeat(extra) }),
    cap: MIB,
  },
  {
    name: "listCheckRuns",
    call: (client, token, fullName) =>
      client.listCheckRuns(
        { token, fullName, headSha: SHA, page: 1 },
        signal(),
      ),
    valid: () =>
      Response.json({ total_count: 1, check_runs: [CHECK_RUN_WIRE] }),
    padded: (extra) =>
      Response.json({
        total_count: 1,
        check_runs: [{
          ...CHECK_RUN_WIRE,
          output: { text: "x".repeat(extra) },
        }],
      }),
    cap: 4 * MIB,
  },
  {
    name: "readRepositoryIdentity",
    call: (client, token, fullName) =>
      client.readRepositoryIdentity({ token, fullName }, signal()),
    valid: () => Response.json({ id: 5, full_name: "o/r" }),
    padded: (extra) =>
      Response.json({
        id: 5,
        full_name: "o/r",
        description: "x".repeat(extra),
      }),
    cap: MIB,
  },
];

Deno.test("issue 71 provider reads: the issue list pages 50 at a time, oldest update first, with the documented query", async () => {
  const { github, repository, fullName, token } = await fixture();
  const start = Date.UTC(2026, 9, 1);
  github.seedIssues(
    repository.id,
    Array.from({ length: 120 }, (_, index) => ({
      updatedAt: fakeTimestamp(start + index * 1000),
    })),
  );
  const pages = [];
  for (const page of [1, 2, 3]) {
    pages.push(
      await github.client.listRepositoryIssues(
        { token, fullName, state: "open", page },
        signal(),
      ),
    );
  }
  assertEquals(
    pages.map((page) => [page.items.length, page.hasNext]),
    [[50, true], [50, true], [20, false]],
  );
  assertEquals(
    pages.flatMap((page) => page.items.map((item) => item.number)),
    Array.from({ length: 120 }, (_, index) => index + 1),
  );
  const calls = github.repositoryReadCalls();
  assertEquals(calls.length, 3);
  const url = new URL(calls[0].url);
  assertEquals(
    url.origin + url.pathname,
    `https://api.github.com/repos/${fullName}/issues`,
  );
  assertEquals(Object.fromEntries(url.searchParams), {
    per_page: "50",
    state: "open",
    sort: "updated",
    direction: "asc",
    page: "1",
  });
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].headers["accept"], "application/vnd.github+json");
  assertEquals(calls[0].headers["x-github-api-version"], "2026-03-10");
  assertEquals(calls[0].headers["authorization"], "Bearer ghs_[redacted]");
  assertEquals(new URL(calls[2].url).searchParams.get("page"), "3");
});

Deno.test("issue 71 provider reads: a full last page and an empty list both end the walk", async () => {
  const { github, repository, fullName, token } = await fixture();
  const list = (page: number) =>
    github.client.listRepositoryIssues(
      { token, fullName, state: "all", page },
      signal(),
    );
  assertEquals(await list(1), { items: [], hasNext: false });
  github.seedIssues(repository.id, Array.from({ length: 50 }, () => ({})));
  const full = await list(1);
  assertEquals([full.items.length, full.hasNext], [50, false]);
  github.seedIssues(repository.id, [{}]);
  const first = await list(1);
  const second = await list(2);
  assertEquals(
    [first.items.length, first.hasNext, second.items.length, second.hasNext],
    [50, true, 1, false],
  );
});

Deno.test("issue 71 provider reads: only the presence of rel=next decides hasNext and the provider URL is never followed", async () => {
  const requests: Request[] = [];
  const link = (value: string | null) =>
    clientFor(
      () =>
        Response.json([ISSUE_WIRE], {
          headers: value === null ? {} : { link: value },
        }),
      requests,
    );
  const next = await link(
    '<https://evil.example/steal?page=2>; rel="next", <https://evil.example/x?page=9>; rel="last"',
  ).listRepositoryIssues(
    { token: "ghs_x", fullName: "o/r", state: "open", page: 1 },
    signal(),
  );
  assertEquals(next.hasNext, true);
  const last = await link('<https://api.github.com/x?page=1>; rel="prev"')
    .listRepositoryIssues(
      { token: "ghs_x", fullName: "o/r", state: "open", page: 1 },
      signal(),
    );
  assertEquals(last.hasNext, false);
  const none = await link(null).listRepositoryIssues(
    { token: "ghs_x", fullName: "o/r", state: "open", page: 1 },
    signal(),
  );
  assertEquals(none.hasNext, false);
  assert(
    requests.every((request) => new URL(request.url).host === "api.github.com"),
  );
  assertEquals(requests.length, 3);
});

Deno.test("issue 71 provider reads: since and state are passed through, and the fake honours both readings of the boundary second", async () => {
  const { github, repository, fullName, token } = await fixture();
  const second = Date.UTC(2026, 9, 31, 12, 0, 0);
  github.seedIssues(repository.id, [
    { updatedAt: fakeTimestamp(second - 1000) },
    { updatedAt: fakeTimestamp(second) },
    { updatedAt: fakeTimestamp(second + 1000) },
    { updatedAt: fakeTimestamp(second + 2000), state: "closed" },
  ]);
  const since = fakeTimestamp(second);
  const list = async (state: "open" | "all") =>
    (await github.client.listRepositoryIssues(
      { token, fullName, state, since, page: 1 },
      signal(),
    )).items.map((item) => item.number);
  assertEquals(github.issueListing.sinceMode, "inclusive");
  assertEquals(await list("open"), [2, 3]);
  assertEquals(await list("all"), [2, 3, 4]);
  github.issueListing.sinceMode = "exclusive";
  assertEquals(await list("open"), [3]);
  assertEquals(await list("all"), [3, 4]);
  const query = new URL(github.repositoryReadCalls()[0].url).searchParams;
  assertEquals(query.get("since"), since);
  assertEquals(query.get("state"), "open");
  assertEquals(
    new URL(github.repositoryReadCalls()[1].url).searchParams.get("state"),
    "all",
  );
  const exclusive = createFakeGitHubApp({ sinceMode: "exclusive" });
  assertEquals(exclusive.issueListing.sinceMode, "exclusive");
});

Deno.test("issue 71 provider reads: a request without since sends no since parameter", async () => {
  const requests: Request[] = [];
  await clientFor(() => Response.json([]), requests).listRepositoryIssues(
    { token: "ghs_x", fullName: "o/r", state: "all", page: 2 },
    signal(),
  );
  const query = new URL(requests[0].url).searchParams;
  assertEquals(query.has("since"), false);
  assertEquals(query.get("state"), "all");
  assertEquals(query.get("page"), "2");
});

Deno.test("issue 71 provider reads: pull request items are marked, never read as issues", async () => {
  const { github, repository, fullName, token } = await fixture();
  const [issue] = github.seedIssues(repository.id, [{ labels: ["bug"] }]);
  const pull = github.seedPullRequest(repository.id, { headSha: SHA });
  const listed = await github.client.listRepositoryIssues(
    { token, fullName, state: "all", page: 1 },
    signal(),
  );
  assertEquals(
    listed.items.map((item) => [item.number, item.kind]),
    [[issue.number, "issue"], [pull.number, "pull_request"]],
  );
  const read = await github.client.readIssue(
    { token, fullName, number: pull.number },
    signal(),
  );
  assert("kind" in read && read.kind === "pull_request");
  const plain = await github.client.readIssue(
    { token, fullName, number: issue.number },
    signal(),
  );
  assertEquals(plain, {
    kind: "issue",
    id: listed.items[0].id,
    number: issue.number,
    state: "open",
    updatedAt: listed.items[0].updatedAt,
    labels: ["bug"],
    locked: false,
    stateReason: null,
  });
  // The title and body GitHub sends never reach the projection.
  assert(!JSON.stringify([listed, plain]).includes("Private repository text"));
  // Whatever value the key carries, its presence marks a pull request.
  const odd = await clientFor(() =>
    Response.json([{ ...ISSUE_WIRE, pull_request: null }, ISSUE_WIRE])
  ).listRepositoryIssues(
    { token: "ghs_x", fullName: "o/r", state: "open", page: 1 },
    signal(),
  );
  assertEquals(odd.items.map((item) => item.kind), ["pull_request", "issue"]);
});

Deno.test("issue 71 provider reads: an edit moves the issue to the end of the updated order, ties included", async () => {
  const { github, repository, fullName, token } = await fixture();
  const base = Date.UTC(2026, 9, 1);
  github.seedIssues(repository.id, [
    { updatedAt: fakeTimestamp(base) },
    { updatedAt: fakeTimestamp(base + 1000) },
    { updatedAt: fakeTimestamp(base + 2000) },
  ]);
  const numbers = async () =>
    (await github.client.listRepositoryIssues(
      { token, fullName, state: "all", page: 1 },
      signal(),
    )).items.map((item) => item.number);
  assertEquals(await numbers(), [1, 2, 3]);
  const edited = github.editIssue(repository.id, 1, { labels: ["edited"] });
  assert(Date.parse(edited.updatedAt) > base + 2000);
  assertEquals(await numbers(), [2, 3, 1]);
  // Items sharing one second keep a stable order, and an edit still lands last.
  const tie = fakeTimestamp(base + 10_000);
  const second = await fixture();
  second.github.seedIssues(second.repository.id, [
    { updatedAt: tie },
    { updatedAt: tie },
    { updatedAt: tie },
  ]);
  const tied = async () =>
    (await second.github.client.listRepositoryIssues(
      { token: second.token, fullName: second.fullName, state: "all", page: 1 },
      signal(),
    )).items.map((item) => item.number);
  assertEquals(await tied(), [1, 2, 3]);
  second.github.editIssue(second.repository.id, 1, { updatedAt: tie });
  assertEquals(await tied(), [2, 3, 1]);
  // Closing is an edit too.
  second.github.editIssue(second.repository.id, 2, { state: "closed" });
  const open = await second.github.client.listRepositoryIssues(
    {
      token: second.token,
      fullName: second.fullName,
      state: "open",
      page: 1,
    },
    signal(),
  );
  assertEquals(open.items.map((item) => item.number), [3, 1]);
});

Deno.test("issue 71 provider reads: a pull request read maps its SHAs and keeps a test merge commit out of mergedSha", async () => {
  const { github, repository, fullName, token } = await fixture();
  const open = github.seedPullRequest(repository.id, {
    headSha: SHA,
    baseSha: OTHER_SHA,
  });
  const read = await github.client.readPullRequest(
    { token, fullName, number: open.number },
    signal(),
  );
  assert("number" in read);
  assertEquals(read, {
    number: open.number,
    state: "open",
    merged: false,
    headSha: SHA,
    baseSha: OTHER_SHA,
    mergedSha: null,
    updatedAt: open.updatedAt,
    url: `https://github.com/${fullName}/pull/${open.number}`,
  });
  // GitHub does send a merge_commit_sha for an open pull request.
  const raw = await github.fetch(
    `https://api.github.com/repos/${fullName}/pulls/${open.number}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert(typeof (await raw.json()).merge_commit_sha === "string");
  const mergedSha = fakeCommitSha();
  const merged = github.seedPullRequest(repository.id, {
    merged: true,
    mergedSha,
  });
  const done = await github.client.readPullRequest(
    { token, fullName, number: merged.number },
    signal(),
  );
  assert("number" in done);
  assertEquals([done.state, done.merged, done.mergedSha], [
    "closed",
    true,
    mergedSha,
  ]);
  // An issue number is not a pull request; an unknown number is gone.
  const [issue] = github.seedIssues(repository.id, [{}]);
  assertEquals(
    await github.client.readPullRequest(
      { token, fullName, number: issue.number },
      signal(),
    ),
    { kind: "gone" },
  );
  assertEquals(
    await github.client.readPullRequest(
      { token, fullName, number: 9999 },
      signal(),
    ),
    { kind: "gone" },
  );
});

Deno.test("issue 71 provider reads: check runs page 50 at a time and carry both timestamps", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedCheckRuns(
    repository.id,
    SHA,
    Array.from({ length: 120 }, (_, index) => ({ name: `check-${index}` })),
  );
  const pages = [];
  for (const page of [1, 2, 3]) {
    pages.push(
      await github.client.listCheckRuns(
        { token, fullName, headSha: SHA, page },
        signal(),
      ),
    );
  }
  assertEquals(
    pages.map((page) => [page.checkRuns.length, page.hasNext, page.totalCount]),
    [[50, true, 120], [50, true, 120], [20, false, 120]],
  );
  assertEquals(pages[0].checkRuns[0].name, "check-0");
  assertEquals(pages[2].checkRuns[19].name, "check-119");
  const url = new URL(github.repositoryReadCalls()[0].url);
  assertEquals(
    url.origin + url.pathname,
    `https://api.github.com/repos/${fullName}/commits/${SHA}/check-runs`,
  );
  assertEquals(Object.fromEntries(url.searchParams), {
    per_page: "50",
    page: "1",
  });
  github.seedCheckRuns(repository.id, OTHER_SHA, [
    { status: "in_progress", appId: 99, appSlug: "other-ci", name: "build" },
    { status: "queued", startedAt: null, completedAt: null },
    {
      status: "completed",
      conclusion: "failure",
      startedAt: "2026-10-31T11:00:00Z",
      completedAt: "2026-10-31T11:09:00Z",
    },
  ]);
  const { checkRuns } = await github.client.listCheckRuns(
    { token, fullName, headSha: OTHER_SHA, page: 1 },
    signal(),
  );
  assertEquals(checkRuns[0], {
    id: checkRuns[0].id,
    name: "build",
    status: "in_progress",
    conclusion: null,
    appId: 99,
    appSlug: "other-ci",
    headSha: OTHER_SHA,
    startedAt: checkRuns[0].startedAt,
    completedAt: null,
  });
  assert(checkRuns[0].startedAt !== null);
  assertEquals([checkRuns[1].startedAt, checkRuns[1].completedAt], [
    null,
    null,
  ]);
  assertEquals(
    [checkRuns[2].conclusion, checkRuns[2].startedAt, checkRuns[2].completedAt],
    ["failure", "2026-10-31T11:00:00Z", "2026-10-31T11:09:00Z"],
  );
  // A commit GitHub holds no runs for is an empty list, not an error.
  assertEquals(
    await github.client.listCheckRuns(
      { token, fullName, headSha: fakeCommitSha(), page: 1 },
      signal(),
    ),
    { checkRuns: [], hasNext: false, totalCount: 0 },
  );
});

Deno.test("issue 71 provider reads: a check run whose App is gone stays in the page with a null author and its siblings are returned", async () => {
  const { app: _app, ...withoutApp } = CHECK_RUN_WIRE;
  const runsOf = (check_runs: unknown[]) =>
    clientFor(() =>
      Response.json({ total_count: check_runs.length, check_runs })
    )
      .listCheckRuns(
        { token: "ghs_x", fullName: "o/r", headSha: SHA, page: 1 },
        signal(),
      );
  const result = await runsOf([
    { ...CHECK_RUN_WIRE, id: 31, name: "first" },
    { ...CHECK_RUN_WIRE, id: 32, name: "app-null", app: null },
    { ...withoutApp, id: 33, name: "app-absent" },
    {
      ...CHECK_RUN_WIRE,
      id: 34,
      name: "last",
      app: { id: 7, slug: "other-ci" },
    },
  ]);
  assertEquals([result.hasNext, result.totalCount], [false, 4]);
  assertEquals(
    result.checkRuns.map((run) => [run.id, run.name, run.appId, run.appSlug]),
    [
      [31, "first", 15_368, "github-actions"],
      [32, "app-null", null, null],
      [33, "app-absent", null, null],
      [34, "last", 7, "other-ci"],
    ],
  );
  // Only the author is unknown: everything else about the run is kept.
  assertEquals(result.checkRuns[1], {
    id: 32,
    name: "app-null",
    status: "completed",
    conclusion: "success",
    appId: null,
    appSlug: null,
    headSha: SHA,
    startedAt: "2026-10-31T11:00:00Z",
    completedAt: "2026-10-31T11:05:00Z",
  });
  // Through the fake: a seeded run without an App is `app: null` on the wire.
  const { github, repository, fullName, token } = await fixture();
  const seeded = github.seedCheckRuns(repository.id, OTHER_SHA, [
    { name: "before" },
    { name: "orphan", appId: null, appSlug: null },
    { name: "id-null", appId: null },
    { name: "slug-null", appSlug: null },
    { name: "after", appId: 99, appSlug: "other-ci" },
  ]);
  // Either field set to null means the run has no App at all.
  assertEquals(
    seeded.map((run) => [run.name, run.appId, run.appSlug]),
    [
      ["before", 15_368, "github-actions"],
      ["orphan", null, null],
      ["id-null", null, null],
      ["slug-null", null, null],
      ["after", 99, "other-ci"],
    ],
  );
  const raw = await github.fetch(
    `https://api.github.com/repos/${fullName}/commits/${OTHER_SHA}/check-runs`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assertEquals(
    (await raw.json()).check_runs.map((run: { app: unknown }) =>
      run.app === null
    ),
    [false, true, true, true, false],
  );
  const listed = await github.client.listCheckRuns(
    { token, fullName, headSha: OTHER_SHA, page: 1 },
    signal(),
  );
  assertEquals(
    listed.checkRuns.map((run) => [run.name, run.appId, run.appSlug]),
    [
      ["before", 15_368, "github-actions"],
      ["orphan", null, null],
      ["id-null", null, null],
      ["slug-null", null, null],
      ["after", 99, "other-ci"],
    ],
  );
  assertEquals(listed.totalCount, 5);
});

Deno.test("issue 71 provider reads: a non-null state_reason comes back as stateReason and a missing one as null", async () => {
  const { github, repository, fullName, token } = await fixture();
  const [notPlanned, completed, open] = github.seedIssues(repository.id, [
    { state: "closed", stateReason: "not_planned" },
    { state: "closed", stateReason: "completed" },
    {},
  ]);
  const listed = await github.client.listRepositoryIssues(
    { token, fullName, state: "all", page: 1 },
    signal(),
  );
  assertEquals(
    listed.items.map((item) => [item.number, item.state, item.stateReason]),
    [
      [notPlanned.number, "closed", "not_planned"],
      [completed.number, "closed", "completed"],
      [open.number, "open", null],
    ],
  );
  const read = await github.client.readIssue(
    { token, fullName, number: notPlanned.number },
    signal(),
  );
  assert("kind" in read && read.kind === "issue");
  assertEquals(read.stateReason, "not_planned");
  // Straight from the wire, with the key set, null and left out.
  const { state_reason: _reason, ...withoutReason } = ISSUE_WIRE;
  const wired = await clientFor(() =>
    Response.json([
      { ...ISSUE_WIRE, state: "closed", state_reason: "not_planned" },
      { ...ISSUE_WIRE, state: "closed", state_reason: "reopened" },
      ISSUE_WIRE,
      withoutReason,
    ])
  ).listRepositoryIssues(
    { token: "ghs_x", fullName: "o/r", state: "all", page: 1 },
    signal(),
  );
  assertEquals(wired.items.map((item) => item.stateReason), [
    "not_planned",
    "reopened",
    null,
    null,
  ]);
});

Deno.test("issue 71 provider reads: a check run name is cut to 255 characters and a shorter name is kept whole", async () => {
  const nameOf = async (name: string) =>
    (await clientFor(() =>
      Response.json({
        total_count: 1,
        check_runs: [{ ...CHECK_RUN_WIRE, name }],
      })
    ).listCheckRuns(
      { token: "ghs_x", fullName: "o/r", headSha: SHA, page: 1 },
      signal(),
    )).checkRuns[0].name;
  assertEquals(await nameOf("ci"), "ci");
  assertEquals(await nameOf("n".repeat(254)), "n".repeat(254));
  assertEquals(await nameOf("n".repeat(255)), "n".repeat(255));
  // The first 255 characters are the ones kept.
  const kept = "a".repeat(255);
  assertEquals(await nameOf(kept + "b"), kept);
  assertEquals(await nameOf(kept + "b".repeat(45)), kept);
});

Deno.test("issue 71 provider reads: a page above the 100 item schema bound is refused and a page of exactly 100 is accepted", async () => {
  const issues = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => ({ ...ISSUE_WIRE, id: index + 1, number: index + 1 }),
    );
  const checkRuns = (count: number) => ({
    total_count: count,
    check_runs: Array.from(
      { length: count },
      (_, index) => ({ ...CHECK_RUN_WIRE, id: index + 1 }),
    ),
  });
  const issuePage = (count: number) =>
    clientFor(() => Response.json(issues(count))).listRepositoryIssues(
      { token: "ghs_x", fullName: "o/r", state: "open", page: 1 },
      signal(),
    );
  const checkPage = (count: number) =>
    clientFor(() => Response.json(checkRuns(count))).listCheckRuns(
      { token: "ghs_x", fullName: "o/r", headSha: SHA, page: 1 },
      signal(),
    );
  assertEquals((await issuePage(100)).items.length, 100);
  assertEquals((await checkPage(100)).checkRuns.length, 100);
  for (
    const [label, call] of [
      ["issue page", () => issuePage(101)],
      ["check run page", () => checkPage(101)],
    ] as [string, () => Promise<unknown>][]
  ) {
    const error = await assertRejects(call, StandardError, undefined, label);
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", label);
    assertEquals(error.cause, undefined, label);
  }
});

Deno.test("issue 71 provider reads: 301 and 308 are moved, 404 and 410 are gone, nothing else is absent", async () => {
  const reads = READS.filter((read) =>
    ["readIssue", "readPullRequest", "readRepositoryIdentity"].includes(
      read.name,
    )
  );
  const cases: [number, unknown][] = [
    [301, { kind: "moved" }],
    [308, { kind: "moved" }],
    [404, { kind: "gone" }],
    [410, { kind: "gone" }],
  ];
  for (const read of reads) {
    for (const [status, expected] of cases) {
      const requests: Request[] = [];
      const client = clientFor(
        () =>
          status === 301 || status === 308
            ? new Response(null, {
              status,
              headers: { location: "https://evil.example/elsewhere" },
            })
            : Response.json({ message: "provider text" }, { status }),
        requests,
      );
      assertEquals(
        await read.call(client, "ghs_x", "o/r"),
        expected,
        `${read.name} ${status}`,
      );
      // The redirect is never followed.
      assertEquals(requests.length, 1, `${read.name} ${status}`);
    }
    for (const status of [302, 307, 400, 422, 500, 502]) {
      const error = await assertRejects(
        () =>
          read.call(
            clientFor(() => Response.json({ message: "x" }, { status })),
            "ghs_x",
            "o/r",
          ),
        StandardError,
        undefined,
        `${read.name} ${status}`,
      );
      assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
    }
    // A rate-limited answer is a failure, never "gone" or "moved".
    for (const status of [403, 404, 429]) {
      const limited = clientFor(() =>
        Response.json({ message: "limit" }, {
          status,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "10" },
        })
      );
      const outcome = await read.call(limited, "ghs_x", "o/r").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      assert(
        "error" in outcome,
        `${read.name} ${status} was read as ${JSON.stringify(outcome)}`,
      );
      if (status === 404) {
        assert(outcome.error instanceof StandardError);
      } else {
        assert(outcome.error instanceof GitHubReadFailure);
        assertEquals(outcome.error.kind, "rate_limited");
      }
    }
  }
});

Deno.test("issue 71 provider reads: the fake answers 301 for a renamed repository and a transferred issue, 410 for a deleted one, 404 for a missing one", async () => {
  const { github, repository, fullName, token, installed } = await fixture();
  const [kept, transferred, deleted] = github.seedIssues(repository.id, [
    {},
    {},
    {},
  ]);
  github.transferIssue(repository.id, transferred.number);
  github.deleteIssue(repository.id, deleted.number);
  const issue = (number: number) =>
    github.client.readIssue({ token, fullName, number }, signal());
  assertEquals((await issue(kept.number)).kind, "issue");
  assertEquals(await issue(transferred.number), { kind: "moved" });
  assertEquals(await issue(deleted.number), { kind: "gone" });
  assertEquals(await issue(9999), { kind: "gone" });
  const status = async (number: number) =>
    (await github.fetch(
      `https://api.github.com/repos/${fullName}/issues/${number}`,
      { headers: { authorization: `Bearer ${token}` } },
    )).status;
  assertEquals(
    [
      await status(transferred.number),
      await status(deleted.number),
      await status(9999),
    ],
    [301, 410, 404],
  );
  // The transferred issue left the list; the repository still answers.
  const listed = await github.client.listRepositoryIssues(
    { token, fullName, state: "all", page: 1 },
    signal(),
  );
  assertEquals(listed.items.map((item) => item.number), [kept.number]);
  assertEquals(
    await github.client.readRepositoryIdentity({ token, fullName }, signal()),
    { kind: "present", id: repository.id },
  );

  const oldName = fullName;
  github.renameRepository(repository.id, "renamed-repository");
  const newName = `${installed.account.login}/renamed-repository`;
  assertEquals(
    await github.client.readIssue({
      token,
      fullName: oldName,
      number: kept.number,
    }, signal()),
    { kind: "moved" },
  );
  assertEquals(
    await github.client.readPullRequest(
      { token, fullName: oldName, number: 1 },
      signal(),
    ),
    { kind: "moved" },
  );
  assertEquals(
    await github.client.readRepositoryIdentity(
      { token, fullName: oldName },
      signal(),
    ),
    { kind: "moved" },
  );
  assertEquals(
    await github.client.readRepositoryIdentity(
      { token, fullName: newName },
      signal(),
    ),
    { kind: "present", id: repository.id },
  );
  assertEquals(
    (await github.client.readIssue({
      token,
      fullName: newName,
      number: kept.number,
    }, signal())).kind,
    "issue",
  );
  // Lists have no moved result: the old name is an unavailable dependency.
  for (
    const call of [
      () =>
        github.client.listRepositoryIssues(
          { token, fullName: oldName, state: "all", page: 1 },
          signal(),
        ),
      () =>
        github.client.listCheckRuns(
          { token, fullName: oldName, headSha: SHA, page: 1 },
          signal(),
        ),
    ]
  ) {
    const error = await assertRejects(call, StandardError);
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
  }
  assertEquals(
    await github.client.readRepositoryIdentity(
      { token, fullName: `${installed.account.login}/never-existed` },
      signal(),
    ),
    { kind: "gone" },
  );
});

Deno.test("issue 71 provider reads: a reused repository name reads as a different repository id", async () => {
  const { github, installed, repository, fullName, mint } = await fixture();
  const oldName = repository.name;
  github.renameRepository(repository.id, "moved-away");
  const reused = {
    id: repository.id + 1_000_000,
    name: oldName,
    private: false,
    archived: false,
    permissions: null,
  };
  installed.repositories.push(reused);
  const token = await mint([reused.id]);
  const identity = await github.client.readRepositoryIdentity(
    { token, fullName },
    signal(),
  );
  // The old name now belongs to another repository: the stored id no longer matches.
  assertEquals(identity, { kind: "present", id: reused.id });
  assert(identity.kind === "present" && identity.id !== repository.id);
  // The issue the first repository had is a 404 here, not proof it was deleted.
  assertEquals(
    await github.client.readIssue({ token, fullName, number: 1 }, signal()),
    { kind: "gone" },
  );
});

Deno.test("issue 71 provider reads: the fake needs a token minted for the repository and the permission, like GitHub", async () => {
  const {
    github,
    installed,
    repository,
    other,
    fullName,
    otherFullName,
    token,
    mint,
  } = await fixture();
  const read = (
    value: string,
    path = "",
  ) =>
    github.fetch(`https://api.github.com/repos/${value}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  // Another repository of the same installation: 404, as GitHub hides it.
  assertEquals((await read(otherFullName)).status, 404);
  assertEquals((await read(otherFullName, "/issues?per_page=50")).status, 404);
  assertEquals((await read(fullName)).status, 200);
  assertEquals(
    await github.client.readIssue(
      { token, fullName: otherFullName, number: 1 },
      signal(),
    ),
    { kind: "gone" },
  );
  // No token, a made-up token and a revoked token are 401.
  const noToken = await github.fetch(
    `https://api.github.com/repos/${fullName}`,
  );
  assertEquals(noToken.status, 401);
  const madeUp = await github.fetch(
    `https://api.github.com/repos/${fullName}`,
    {
      headers: { authorization: "Bearer ghs_madeup" },
    },
  );
  assertEquals(madeUp.status, 401);
  const revoked = await mint([repository.id]);
  github.revokedTokens.push(revoked);
  const revokedRead = await assertRejects(
    () =>
      github.client.readRepositoryIdentity(
        { token: revoked, fullName },
        signal(),
      ),
    GitHubReadFailure,
  );
  assertEquals(revokedRead.kind, "rejected");
  // A token without the route's permission is 403: forbidden, with metadata always allowed.
  const metadataOnly = await mint([repository.id], { metadata: "read" });
  assertEquals(
    await github.client.readRepositoryIdentity(
      { token: metadataOnly, fullName },
      signal(),
    ),
    { kind: "present", id: repository.id },
  );
  const forbidden = async (call: () => Promise<unknown>) =>
    (await assertRejects(call, GitHubReadFailure)).kind;
  assertEquals(
    await forbidden(() =>
      github.client.listRepositoryIssues(
        { token: metadataOnly, fullName, state: "open", page: 1 },
        signal(),
      )
    ),
    "forbidden",
  );
  assertEquals(
    await forbidden(() =>
      github.client.readPullRequest(
        { token: metadataOnly, fullName, number: 1 },
        signal(),
      )
    ),
    "forbidden",
  );
  assertEquals(
    await forbidden(() =>
      github.client.listCheckRuns(
        { token: metadataOnly, fullName, headSha: SHA, page: 1 },
        signal(),
      )
    ),
    "forbidden",
  );
  // Each permission opens only its own route.
  const checksOnly = await mint([repository.id], {
    metadata: "read",
    checks: "write",
  });
  assertEquals(
    (await github.client.listCheckRuns(
      { token: checksOnly, fullName, headSha: SHA, page: 1 },
      signal(),
    )).totalCount,
    0,
  );
  assertEquals(
    await forbidden(() =>
      github.client.readIssue(
        { token: checksOnly, fullName, number: 1 },
        signal(),
      )
    ),
    "forbidden",
  );
  const pullsOnly = await mint([repository.id], {
    metadata: "read",
    pull_requests: "read",
  });
  github.seedIssues(repository.id, [{}]);
  assertEquals(
    (await github.client.readIssue(
      { token: pullsOnly, fullName, number: 1 },
      signal(),
    )).kind,
    "issue",
  );
  // An unnarrowed token covers every repository of the installation.
  const discovery = await github.client.mintDiscoveryToken({
    jwt: await createGitHubAppJwt(installed.appId, fakeAppKey.pem),
    installationId: installed.id,
  }, signal());
  assert(discovery.kind === "minted");
  assertEquals(
    await github.client.readRepositoryIdentity(
      { token: discovery.token, fullName: otherFullName },
      signal(),
    ),
    { kind: "present", id: other.id },
  );
  // A suspended installation is 403 on every read.
  github.setInstallationState(installed.id, "suspended");
  assertEquals((await read(fullName)).status, 403);
});

Deno.test("issue 71 provider reads: failNext scripts one failure per matching request and leaves other routes alone", async () => {
  const { github, repository, fullName, token } = await fixture(200);
  const list = () =>
    github.client.listRepositoryIssues(
      { token, fullName, state: "open", page: 1 },
      signal(),
    );
  github.seedIssues(repository.id, [{}]);
  github.failNext("issues", "server_error");
  // Another route is untouched and does not consume the failure.
  assertEquals(
    await github.client.readRepositoryIdentity({ token, fullName }, signal()),
    { kind: "present", id: repository.id },
  );
  const failed = await assertRejects(list, StandardError);
  assertEquals(failed.code, "DEPENDENCY_UNAVAILABLE");
  assert(!surface(failed).includes(FAKE_PROVIDER_CANARY));
  assertEquals((await list()).items.length, 1);
  // A count queues several, in order.
  github.failNext("issues", "rate_limited", 2);
  github.failNext("issues", "quota");
  const kinds = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const error = await assertRejects(list, GitHubReadFailure);
    kinds.push([error.kind, error.retryAfterSeconds]);
  }
  assertEquals(kinds.map(([kind]) => kind), [
    "rate_limited",
    "rate_limited",
    "rate_limited",
  ]);
  assertEquals(kinds[2][1], 30);
  assertEquals((await list()).items.length, 1);
});

Deno.test("issue 71 provider reads: every read reports rate limits with a bounded wait and keeps other failures redacted", async () => {
  const routes: [
    FakeReadRoute,
    (
      github: Awaited<ReturnType<typeof fixture>>,
    ) => Promise<unknown>,
  ][] = [
    ["issues", (f) =>
      f.github.client.listRepositoryIssues(
        { token: f.token, fullName: f.fullName, state: "open", page: 1 },
        signal(),
      )],
    ["issue", (f) =>
      f.github.client.readIssue(
        { token: f.token, fullName: f.fullName, number: 1 },
        signal(),
      )],
    ["pull", (f) =>
      f.github.client.readPullRequest(
        { token: f.token, fullName: f.fullName, number: 1 },
        signal(),
      )],
    ["check-runs", (f) =>
      f.github.client.listCheckRuns(
        { token: f.token, fullName: f.fullName, headSha: SHA, page: 1 },
        signal(),
      )],
    ["repository", (f) =>
      f.github.client.readRepositoryIdentity(
        { token: f.token, fullName: f.fullName },
        signal(),
      )],
  ];
  const f = await fixture(200);
  for (const [route, call] of routes) {
    const expectations: [
      Parameters<typeof f.github.failNext>[1],
      string,
      number | null,
    ][] = [
      ["rate_limited", "rate_limited", 120],
      ["quota", "rate_limited", 30],
      ["unauthorized", "rejected", null],
      ["forbidden", "forbidden", null],
      ["hang", "timeout", null],
    ];
    for (const [script, kind, wait] of expectations) {
      f.github.failNext(route, script);
      const error = await assertRejects(
        () => call(f),
        GitHubReadFailure,
        undefined,
        `${route} ${script}`,
      );
      assertEquals(error.kind, kind, `${route} ${script}`);
      if (wait === null) assertEquals(error.retryAfterSeconds, null);
      else {
        assert(
          error.retryAfterSeconds !== null &&
            error.retryAfterSeconds >= wait - 2 &&
            error.retryAfterSeconds <= wait,
          `${route} ${script}: ${error.retryAfterSeconds}`,
        );
      }
      assertEquals(error.message, "GITHUB_READ_FAILURE");
      assert(
        !surface(error).includes(FAKE_PROVIDER_CANARY),
        `${route} ${script}`,
      );
      assert(!surface(error).includes(f.token), `${route} ${script}`);
    }
    f.github.failNext(route, "server_error");
    const outage = await assertRejects(() => call(f), StandardError);
    assertEquals(outage.code, "DEPENDENCY_UNAVAILABLE");
    assert(!surface(outage).includes(FAKE_PROVIDER_CANARY), route);
  }
});

Deno.test("issue 71 provider reads: the rate-limit wait is read from the headers and bounded to 1..3600 seconds", async () => {
  const wait = async (headers: Record<string, string>, status = 429) => {
    const client = clientFor(() =>
      Response.json({ message: "limit" }, { status, headers })
    );
    const error = await assertRejects(
      () =>
        client.readIssue(
          { token: "ghs_x", fullName: "o/r", number: 1 },
          signal(),
        ),
      GitHubReadFailure,
    );
    assertEquals(error.kind, "rate_limited");
    return error.retryAfterSeconds;
  };
  assertEquals(await wait({ "retry-after": "45" }), 45);
  assertEquals(await wait({ "retry-after": "0" }), 1);
  assertEquals(await wait({ "retry-after": "999999" }), 3600);
  assertEquals(await wait({}), 60);
  assertEquals(
    await wait({}, 403).catch(() => "not a rate limit"),
    "not a rate limit",
  );
  const past = String(Math.floor(Date.now() / 1000) - 600);
  assertEquals(
    await wait(
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": past },
      403,
    ),
    1,
  );
  const far = String(Math.floor(Date.now() / 1000) + 86_400);
  assertEquals(
    await wait({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": far }, 403),
    3600,
  );
  const soon = String(Math.floor(Date.now() / 1000) + 90);
  const bounded = await wait(
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": soon },
    403,
  );
  assert(bounded !== null && bounded >= 88 && bounded <= 90, String(bounded));
});

Deno.test("issue 71 provider reads: malformed answers are DEPENDENCY_UNAVAILABLE and never echo the provider body", async () => {
  const leaked = "provider-body-secret-value";
  for (const read of READS) {
    const answer = await read.call(
      clientFor(() => read.valid()),
      "ghs_x",
      "o/r",
    );
    assert(answer !== undefined, `${read.name} accepts a valid answer`);
    const cases: [string, () => Response][] = [
      ["empty object", () => Response.json({ leaked })],
      ["empty array", () => Response.json([leaked])],
      ["string", () => Response.json(leaked)],
      ["null", () => Response.json(null)],
      ["not JSON", () => new Response(`{${leaked}`)],
      ["html", () => new Response(`<html>${leaked}</html>`)],
      [
        "invalid UTF-8",
        () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
      ],
      [
        "201 instead of 200",
        () => new Response(read.valid().body, { status: 201 }),
      ],
      ["empty body", () => new Response(null, { status: 200 })],
    ];
    for (const [label, respond] of cases) {
      const error = await assertRejects(
        () => read.call(clientFor(() => respond()), "ghs_x", "o/r"),
        StandardError,
        undefined,
        `${read.name} ${label}`,
      );
      assertEquals(
        error.code,
        "DEPENDENCY_UNAVAILABLE",
        `${read.name} ${label}`,
      );
      assert(!surface(error).includes(leaked), `${read.name} ${label}`);
      assertEquals(error.cause, undefined, `${read.name} ${label}`);
    }
  }
});

Deno.test("issue 71 provider reads: fields the projection needs are required and checked", async () => {
  const reject = async (
    call: (client: GitHubAppClient) => Promise<unknown>,
    body: unknown,
    label: string,
  ) => {
    const error = await assertRejects(
      () => call(clientFor(() => Response.json(body))),
      StandardError,
      undefined,
      label,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", label);
  };
  const issue = (client: GitHubAppClient) =>
    client.readIssue({ token: "ghs_x", fullName: "o/r", number: 7 }, signal());
  const { id: _id, ...withoutId } = ISSUE_WIRE;
  await reject(issue, withoutId, "issue without id");
  await reject(issue, { ...ISSUE_WIRE, state: "merged" }, "issue state");
  await reject(issue, { ...ISSUE_WIRE, number: 0 }, "issue number");
  await reject(issue, { ...ISSUE_WIRE, updated_at: "yesterday" }, "issue time");
  await reject(issue, { ...ISSUE_WIRE, updated_at: 1761912000 }, "issue epoch");
  await reject(issue, { ...ISSUE_WIRE, labels: [5] }, "issue label");
  await reject(issue, { ...ISSUE_WIRE, locked: "no" }, "issue locked");
  const pull = (client: GitHubAppClient) =>
    client.readPullRequest(
      { token: "ghs_x", fullName: "o/r", number: 7 },
      signal(),
    );
  await reject(pull, { ...PULL_WIRE, head: { sha: "ABC" } }, "pull head sha");
  await reject(pull, { ...PULL_WIRE, base: {} }, "pull base");
  await reject(pull, { ...PULL_WIRE, merged: undefined }, "pull merged");
  await reject(pull, { ...PULL_WIRE, html_url: "not a url" }, "pull url");
  await reject(
    pull,
    { ...PULL_WIRE, merge_commit_sha: "xyz" },
    "pull merge sha",
  );
  const runs = (client: GitHubAppClient) =>
    client.listCheckRuns(
      { token: "ghs_x", fullName: "o/r", headSha: SHA, page: 1 },
      signal(),
    );
  const page = (run: unknown) => ({ total_count: 1, check_runs: [run] });
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, app: { id: 0, slug: "ci" } }),
    "check run app id",
  );
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, app: { id: 7 } }),
    "check run app slug",
  );
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, app: { id: 7, slug: "" } }),
    "check run app empty slug",
  );
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, app: { id: 7, slug: "a".repeat(101) } }),
    "check run app slug of 101 characters",
  );
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, app: "github-actions" }),
    "check run app string",
  );
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, head_sha: "short" }),
    "check run sha",
  );
  await reject(
    runs,
    page({ ...CHECK_RUN_WIRE, started_at: "soon" }),
    "check run time",
  );
  await reject(runs, { check_runs: [] }, "check runs without total");
  await reject(runs, { total_count: -1, check_runs: [] }, "negative total");
  const identity = (client: GitHubAppClient) =>
    client.readRepositoryIdentity(
      { token: "ghs_x", fullName: "o/r" },
      signal(),
    );
  await reject(identity, { id: "7" }, "identity string id");
  await reject(identity, { id: 0 }, "identity zero id");
  await reject(identity, {}, "identity without id");
});

Deno.test("issue 71 provider reads: a present App slug of one to 100 characters is kept as sent", async () => {
  const slugs = ["a", "ci", "a".repeat(99), "a".repeat(100)];
  const result = await clientFor(() =>
    Response.json({
      total_count: slugs.length,
      check_runs: slugs.map((slug, index) => ({
        ...CHECK_RUN_WIRE,
        id: 500 + index,
        app: { id: 7 + index, slug },
      })),
    })
  ).listCheckRuns(
    { token: "ghs_x", fullName: "o/r", headSha: SHA, page: 1 },
    signal(),
  );
  assertEquals(
    result.checkRuns.map((run) => [run.appId, run.appSlug]),
    slugs.map((slug, index) => [7 + index, slug]),
  );
});

Deno.test("issue 71 provider reads: single reads are capped at 1 MiB and list pages at 4 MiB", async () => {
  for (const read of READS) {
    // Far above the 256 KiB default of the older calls, below this call's cap.
    const roomy = Math.min(read.cap - 4096, 3 * MIB);
    const accepted = await read.call(
      clientFor(() => read.padded(roomy)),
      "ghs_x",
      "o/r",
    );
    assert(
      accepted !== undefined,
      `${read.name} accepts a ${roomy} byte answer`,
    );
    const error = await assertRejects(
      () =>
        read.call(
          clientFor(() => new Response("x".repeat(read.cap + 1))),
          "ghs_x",
          "o/r",
        ),
      StandardError,
      undefined,
      `${read.name} over its cap`,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", read.name);
    const padded = await assertRejects(
      () =>
        read.call(
          clientFor(() => read.padded(read.cap)),
          "ghs_x",
          "o/r",
        ),
      StandardError,
      undefined,
      `${read.name} padded over its cap`,
    );
    assertEquals(padded.code, "DEPENDENCY_UNAVAILABLE", read.name);
  }
});

Deno.test("issue 71 provider reads: labels are reduced to at most 50 names of at most 50 characters", async () => {
  const names = Array.from({ length: 80 }, (_, index) => `label-${index}`);
  names[3] = "L".repeat(200);
  const fromRaw = async (labels: unknown[]) =>
    (await clientFor(() => Response.json([{ ...ISSUE_WIRE, labels }]))
      .listRepositoryIssues(
        { token: "ghs_x", fullName: "o/r", state: "open", page: 1 },
        signal(),
      )).items[0].labels;
  for (
    const [label, labels] of [
      ["objects", names.map((name) => ({ id: 1, name, color: "ededed" }))],
      ["strings", names],
      ["mixed", names.map((name, index) => index % 2 ? name : { name })],
    ] as [string, unknown[]][]
  ) {
    const kept = await fromRaw(labels);
    assertEquals(kept.length, GITHUB_MAX_LABELS, label);
    assert(kept.every((name) => name.length <= GITHUB_MAX_LABEL_LENGTH), label);
    assertEquals(kept[0], "label-0", label);
    assertEquals(kept[3], "L".repeat(GITHUB_MAX_LABEL_LENGTH), label);
    assertEquals(kept[49], "label-49", label);
  }
  assertEquals(await fromRaw([]), []);
  // Through the fake, as a stored issue with more labels than the bound.
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ labels: names }]);
  const [item] = (await github.client.listRepositoryIssues(
    { token, fullName, state: "open", page: 1 },
    signal(),
  )).items;
  assertEquals(item.labels.length, GITHUB_MAX_LABELS);
  assert(item.labels.every((name) => name.length <= GITHUB_MAX_LABEL_LENGTH));
});

Deno.test("issue 71 provider reads: the request path is built from the validated full name and is never altered by crafted input, so it targets exactly the repository, issue, pull request or commit", async () => {
  const requests: Request[] = [];
  const client = clientFor(
    (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/check-runs")) {
        return Response.json({ total_count: 0, check_runs: [] });
      }
      if (pathname.includes("/pulls/")) return Response.json(PULL_WIRE);
      if (pathname.includes("/issues/")) return Response.json(ISSUE_WIRE);
      if (pathname.endsWith("/issues")) return Response.json([]);
      return Response.json({ id: 5 });
    },
    requests,
  );
  const fullName = "Acme-Org/my.repo_x";
  const token = "ghs_path";
  await client.readRepositoryIdentity({ token, fullName }, signal());
  await client.listRepositoryIssues(
    { token, fullName, state: "open", page: 12 },
    signal(),
  );
  await client.readIssue({ token, fullName, number: 12 }, signal());
  await client.readPullRequest({ token, fullName, number: 345 }, signal());
  await client.listCheckRuns(
    { token, fullName, headSha: SHA, page: 2 },
    signal(),
  );
  await client.readRepositoryIdentity(
    { token, fullName: "o/.github" },
    signal(),
  );
  assertEquals(
    requests.map((request) => {
      const url = new URL(request.url);
      return `${request.method} ${url.origin}${url.pathname}`;
    }),
    [
      "GET https://api.github.com/repos/Acme-Org/my.repo_x",
      "GET https://api.github.com/repos/Acme-Org/my.repo_x/issues",
      "GET https://api.github.com/repos/Acme-Org/my.repo_x/issues/12",
      "GET https://api.github.com/repos/Acme-Org/my.repo_x/pulls/345",
      `GET https://api.github.com/repos/Acme-Org/my.repo_x/commits/${SHA}/check-runs`,
      "GET https://api.github.com/repos/o/.github",
    ],
  );
  assert(requests.every((request) => request.redirect === "manual"));
  assertEquals(new URL(requests[1].url).searchParams.get("page"), "12");
  assertEquals(new URL(requests[4].url).searchParams.get("page"), "2");
});

Deno.test("issue 71 provider reads: unsafe inputs are refused before any request so they cannot select another endpoint", async () => {
  const github = createFakeGitHubApp();
  const { client } = github;
  const token = "ghs_never-minted";
  const good = { token, fullName: "owner/repo", number: 1, page: 1 };
  type Input = Partial<
    Record<keyof typeof good | "headSha" | "state" | "since", unknown>
  >;
  const calls: [string, (input: Input) => Promise<unknown>][] = [
    ["listRepositoryIssues", (input) =>
      client.listRepositoryIssues(
        { ...good, state: "open", ...input } as never,
        signal(),
      )],
    [
      "readIssue",
      (input) => client.readIssue({ ...good, ...input } as never, signal()),
    ],
    [
      "readPullRequest",
      (input) =>
        client.readPullRequest({ ...good, ...input } as never, signal()),
    ],
    ["listCheckRuns", (input) =>
      client.listCheckRuns(
        { ...good, headSha: SHA, ...input } as never,
        signal(),
      )],
    [
      "readRepositoryIdentity",
      (input) =>
        client.readRepositoryIdentity({ ...good, ...input } as never, signal()),
    ],
  ];
  const refused: [string, Input, string[]][] = [];
  for (
    const fullName of [
      "../x",
      "a%2fb",
      "owner/..",
      "owner/.",
      "owner/a%2fb",
      "owner/%2e%2e",
      "owner/repo/extra",
      "owner/repo/../../user",
      "",
      "owner",
      "/repo",
      "owner/",
      " owner/repo",
      "owner/repo ",
      "owner/repo?x=1",
      "owner/repo#h",
      "owner/re\npo",
      "-owner/repo",
      "o".repeat(40) + "/repo",
      "owner/" + "r".repeat(101),
      "owner\\repo",
    ]
  ) {
    refused.push([
      `fullName ${JSON.stringify(fullName)}`,
      { fullName },
      calls.map(([name]) => name),
    ]);
  }
  refused.push([
    "fullName non-string",
    { fullName: 5 },
    calls.map(([name]) => name),
  ]);
  for (
    const number of [
      0,
      -1,
      1.5,
      Number.NaN,
      Infinity,
      2 ** 53,
      "1",
      null,
      undefined,
    ]
  ) {
    refused.push([`number ${String(number)}`, { number }, [
      "readIssue",
      "readPullRequest",
    ]]);
  }
  for (
    const page of [0, -1, 1.5, Number.NaN, 2 ** 53, "1", null, undefined]
  ) {
    refused.push([`page ${String(page)}`, { page }, [
      "listRepositoryIssues",
      "listCheckRuns",
    ]]);
  }
  for (
    const headSha of [
      "a".repeat(39),
      "a".repeat(41),
      "A".repeat(40),
      "A" + "a".repeat(39),
      "g".repeat(40),
      "",
      "a".repeat(39) + "/",
      "../".repeat(13) + "a",
      "a".repeat(38) + "%2f",
      5,
      undefined,
    ]
  ) {
    refused.push([`headSha ${JSON.stringify(headSha)}`, { headSha }, [
      "listCheckRuns",
    ]]);
  }
  for (const state of ["closed", "ALL", "", "open&state=all", undefined]) {
    refused.push([`state ${JSON.stringify(state)}`, { state }, [
      "listRepositoryIssues",
    ]]);
  }
  for (
    const since of [
      "yesterday",
      "2026-10-31",
      "2026-10-31T12:00:00",
      "1; drop",
      "",
      "2026-10-31T12:00:00Z&state=all",
      5,
    ]
  ) {
    refused.push([`since ${JSON.stringify(since)}`, { since }, [
      "listRepositoryIssues",
    ]]);
  }
  for (const badToken of ["", "x".repeat(4097), 5, null, undefined]) {
    refused.push([`token ${JSON.stringify(badToken)?.slice(0, 12)}`, {
      token: badToken,
    }, calls.map(([name]) => name)]);
  }
  for (const [label, input, names] of refused) {
    for (const [name, call] of calls) {
      if (!names.includes(name)) continue;
      const error = await assertRejects(
        () => call(input),
        StandardError,
        undefined,
        `${name} ${label}`,
      );
      assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", `${name} ${label}`);
    }
  }
  // The fake saw nothing: every refusal happened before fetch.
  assertEquals(github.calls.length, 0);
  // The same calls with good input do reach the fake.
  const reached = await assertRejects(
    () => calls[1][1]({}),
    GitHubReadFailure,
  );
  assertEquals(reached.kind, "rejected");
  assertEquals(github.calls.length, 1);
});

Deno.test("issue 71 provider reads: the token travels only in the Authorization header and never reaches an error or a result", async () => {
  const token = "ghs_secret-token-value-9f2c";
  const leaked = "provider-body-secret-value";
  const seen: Request[] = [];
  const answers: [string, () => Response][] = [
    ["ok", () => Response.json({})],
    ["401", () => Response.json({ message: leaked }, { status: 401 })],
    ["403", () => Response.json({ message: leaked }, { status: 403 })],
    ["404", () => Response.json({ message: leaked }, { status: 404 })],
    ["429", () =>
      Response.json({ message: leaked }, {
        status: 429,
        headers: { "retry-after": "5", "x-token-echo": token },
      })],
    ["500", () => new Response(`${leaked} ${token}`, { status: 500 })],
    ["malformed", () => new Response(`{${token}`)],
  ];
  for (const read of READS) {
    for (const [label, respond] of answers) {
      const outcome = await read.call(
        clientFor(() => respond(), seen),
        token,
        "o/r",
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if ("error" in outcome) {
        assert(outcome.error instanceof Error, `${read.name} ${label}`);
        assert(
          !surface(outcome.error).includes(token),
          `${read.name} ${label}`,
        );
        assert(
          !surface(outcome.error).includes(leaked),
          `${read.name} ${label}`,
        );
      } else {
        assert(
          !JSON.stringify(outcome.value).includes(token),
          `${read.name} ${label}`,
        );
      }
    }
  }
  assert(seen.length >= READS.length * answers.length);
  for (const request of seen) {
    assert(!request.url.includes(token));
    assertEquals(request.headers.get("authorization"), `Bearer ${token}`);
    assert(
      [...request.headers].every(([name, value]) =>
        name === "authorization" || !value.includes(token)
      ),
    );
    assertEquals(request.method, "GET");
    assertEquals(request.body, null);
  }
  // A successful read returns its data, never the token.
  const { github, repository, fullName, token: minted } = await fixture();
  github.seedIssues(repository.id, [{}]);
  github.seedPullRequest(repository.id, { headSha: SHA });
  github.seedCheckRuns(repository.id, SHA, [{}]);
  const results = [
    await github.client.listRepositoryIssues(
      { token: minted, fullName, state: "all", page: 1 },
      signal(),
    ),
    await github.client.readIssue(
      { token: minted, fullName, number: 1 },
      signal(),
    ),
    await github.client.readPullRequest(
      { token: minted, fullName, number: 2 },
      signal(),
    ),
    await github.client.listCheckRuns(
      { token: minted, fullName, headSha: SHA, page: 1 },
      signal(),
    ),
    await github.client.readRepositoryIdentity(
      { token: minted, fullName },
      signal(),
    ),
  ];
  assert(!JSON.stringify(results).includes(minted));
  assert(
    github.calls.every((call) =>
      !call.url.includes(minted) &&
      Object.entries(call.headers).every(([name, value]) =>
        name === "authorization" || !value.includes(minted)
      )
    ),
  );
});

Deno.test("issue 71 provider reads: a caller that goes away is not a provider timeout", async () => {
  const { github, repository, fullName, token } = await fixture(5_000);
  github.seedIssues(repository.id, [{}]);
  github.failNext("issue", "hang");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const error = await assertRejects(
    () =>
      github.client.readIssue(
        { token, fullName, number: 1 },
        controller.signal,
      ),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
});

Deno.test("issue 71 provider reads: readJson keeps the HTTP status for answers and for absent statuses", async () => {
  const answer = (status: number, body?: string): Transport => ({
    fetch: () =>
      Promise.resolve(
        new Response(body ?? null, {
          status,
          headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
        }),
      ),
    timeoutMs: 500,
  });
  const url = "https://api.github.com/repos/o/r";
  const ok = await readJson(
    answer(200, '{"id":5}'),
    url,
    { method: "GET", expectedStatus: 200 },
    signal(),
  );
  assertEquals(ok, {
    body: { id: 5 },
    link: '<https://api.github.com/x?page=2>; rel="next"',
    status: 200,
  });
  for (const status of [301, 308, 404, 410]) {
    assertEquals(
      await readJson(
        answer(status),
        url,
        {
          method: "GET",
          expectedStatus: 200,
          absentStatuses: [301, 308, 404, 410],
        },
        signal(),
      ),
      { body: null, link: null, status },
    );
  }
  assertEquals(
    await readJson(
      answer(204),
      url,
      { method: "DELETE", expectedStatus: 204 },
      signal(),
    ),
    { body: null, link: null, status: 204 },
  );
  // A status the caller did not list as absent still fails closed.
  const error = await assertRejects(
    () =>
      readJson(
        answer(404),
        url,
        { method: "GET", expectedStatus: 200, absentStatuses: [301] },
        signal(),
      ),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
});
