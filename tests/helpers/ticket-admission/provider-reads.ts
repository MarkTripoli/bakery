import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  createFetchGitHubAppClient,
  createGitHubAppJwt,
  GITHUB_MAX_ISSUE_BODY_CODE_POINTS,
  GITHUB_MAX_ISSUE_TITLE_LENGTH,
  GITHUB_MAX_LABEL_LENGTH,
  GITHUB_MAX_LABELS,
  type GitHubAppClient,
  type GitHubPermissions,
  GitHubReadFailure,
  MAX_ISSUE_DETAIL_BYTES,
} from "../../../apps/server/src/modules/integrations/github-app.ts";
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
 * Provider lane for issue 82, client half: the additive GitHub reads the
 * ticket reader builds on (issue with body and links, blockers, issue events,
 * pull requests of a commit, collaborator permission, repository default
 * branch) against the fake GitHub and against hand-built answers, so every
 * status, size and shape the client must survive is exercised with no network.
 * Fixtures and the fake are not live GitHub proof.
 */

const signal = () => new AbortController().signal;

/** The permissions the ticket reader's read token carries (plan 3b.1). */
const TICKET_PERMISSIONS = {
  metadata: "read",
  issues: "read",
  pull_requests: "read",
} as const satisfies GitHubPermissions;

const SHA = "a".repeat(40);
/** A commit SHA no test seeds a pull request for. */
const UNSEEDED_SHA = "d".repeat(40);

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
    permissions: GitHubPermissions = TICKET_PERMISSIONS,
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
    token: await mint([repository.id]),
    mint,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

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

/** The read is refused as a dependency failure, whatever the cause. */
async function assertUnavailable(
  call: () => Promise<unknown>,
  label: string,
): Promise<StandardError> {
  const error = await assertRejects(call, StandardError, undefined, label);
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE", label);
  return error;
}

const ISSUE_WIRE = {
  id: 11,
  number: 7,
  state: "open",
  state_reason: null,
  title: "Title",
  body: "Body",
  labels: [],
  locked: false,
  updated_at: "2026-10-31T12:00:00Z",
};
const BLOCKER_WIRE = {
  id: 31,
  number: 3,
  state: "open",
  state_reason: null,
  repository_url: "https://api.github.com/repos/o/r",
};
const EVENT_WIRE = {
  id: 41,
  event: "labeled",
  actor: { id: 5, login: "octocat" },
  label: { name: "ready for agent", color: "ededed" },
  commit_id: null,
  created_at: "2026-10-31T12:00:00Z",
};
const PULL_WIRE = {
  number: 9,
  state: "closed",
  merged_at: "2026-10-31T12:00:00Z",
  merge_commit_sha: SHA,
  base: { ref: "main", sha: "b".repeat(40) },
};
const PERMISSION_WIRE = {
  permission: "write",
  role_name: "write",
  user: { id: 5, login: "octocat" },
};

const GOOD_INPUT = {
  token: "ghs_good-token",
  fullName: "o/r",
  number: 5,
  page: 1,
  sha: SHA,
  login: "octocat",
};

/** The five new reads, called with the fields of one input record. */
const READS: {
  name: string;
  route: FakeReadRoute;
  fields: readonly (keyof typeof GOOD_INPUT)[];
  call: (
    client: GitHubAppClient,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}[] = [
  {
    name: "readIssueDetail",
    route: "issue",
    fields: ["token", "fullName", "number"],
    call: (client, input) => client.readIssueDetail(input as never, signal()),
  },
  {
    name: "listBlockedBy",
    route: "blocked-by",
    fields: ["token", "fullName", "number", "page"],
    call: (client, input) => client.listBlockedBy(input as never, signal()),
  },
  {
    name: "listIssueEvents",
    route: "issue-events",
    fields: ["token", "fullName", "number", "page"],
    call: (client, input) => client.listIssueEvents(input as never, signal()),
  },
  {
    name: "listCommitPullRequests",
    route: "commit-pulls",
    fields: ["token", "fullName", "sha", "page"],
    call: (client, input) =>
      client.listCommitPullRequests(input as never, signal()),
  },
  {
    name: "readCollaboratorPermission",
    route: "collaborator-permission",
    fields: ["token", "fullName", "login"],
    call: (client, input) =>
      client.readCollaboratorPermission(input as never, signal()),
  },
];

/** The reads of a fixture's repository, by route, with issue 1 and `octocat` seeded. */
function liveReads(f: Fixture): [FakeReadRoute, () => Promise<unknown>][] {
  const { client } = f.github;
  const base = { token: f.token, fullName: f.fullName };
  return [
    ["issue", () => client.readIssueDetail({ ...base, number: 1 }, signal())],
    [
      "blocked-by",
      () => client.listBlockedBy({ ...base, number: 1, page: 1 }, signal()),
    ],
    [
      "issue-events",
      () => client.listIssueEvents({ ...base, number: 1, page: 1 }, signal()),
    ],
    [
      "commit-pulls",
      () =>
        client.listCommitPullRequests({ ...base, sha: SHA, page: 1 }, signal()),
    ],
    [
      "collaborator-permission",
      () =>
        client.readCollaboratorPermission(
          { ...base, login: "octocat" },
          signal(),
        ),
    ],
  ];
}

Deno.test("issue 82 provider reads: readIssueDetail returns the text, labels, parent and link counts the wire reports", async () => {
  const { github, repository, fullName, token } = await fixture();
  const [issue] = github.seedIssues(repository.id, [
    {
      number: 7,
      labels: ["ready for agent", "bug"],
      updatedAt: "2026-10-31T12:00:00Z",
    },
    { number: 3 },
  ]);
  github.seedIssueDetail(repository.id, 7, {
    title: "Add the thing",
    body: "Line one\r\nLine two\n\n## Acceptance criteria\n- works",
    parentIssueUrl: `https://api.github.com/repos/${fullName}/issues/3`,
    subIssuesTotal: 2,
    blockingTotal: 4,
    repositoryPrivate: true,
  });
  github.seedBlockedBy(repository.id, 7, [{ number: 3 }, { number: 4 }]);
  assertEquals(
    await github.client.readIssueDetail(
      { token, fullName, number: 7 },
      signal(),
    ),
    {
      kind: "issue",
      id: issue.id,
      number: 7,
      state: "open",
      stateReason: null,
      title: "Add the thing",
      // The body is kept as GitHub sent it; newline handling is the snapshot's.
      body: "Line one\r\nLine two\n\n## Acceptance criteria\n- works",
      bodyTooLarge: false,
      labels: ["ready for agent", "bug"],
      labelsTruncated: false,
      locked: false,
      updatedAt: "2026-10-31T12:00:00Z",
      parent: { repositoryFullName: fullName, number: 3 },
      subIssuesTotal: 2,
      blockedByTotal: 2,
      blockingTotal: 4,
      repositoryPrivate: true,
    },
  );
});

Deno.test("issue 82 provider reads: an unseeded issue reads with the fake's default text, no parent and zero counts, and a pull request reads as a pull request", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1, state: "closed" }]);
  const pull = github.seedPullRequest(repository.id, { number: 2 });
  assertEquals(pull.number, 2);
  const issue = await github.client.readIssueDetail(
    { token, fullName, number: 1 },
    signal(),
  );
  assert(issue.kind === "issue");
  assertEquals(issue.title, "Issue 1");
  assertEquals(issue.body, "Body of issue 1. Private repository text.");
  assertEquals(issue.state, "closed");
  assertEquals(issue.parent, null);
  assertEquals(
    [issue.subIssuesTotal, issue.blockedByTotal, issue.blockingTotal],
    [0, 0, 0],
  );
  // The single-issue read carries no repository object, so visibility is unknown.
  assertEquals(issue.repositoryPrivate, null);
  const asPull = await github.client.readIssueDetail(
    { token, fullName, number: 2 },
    signal(),
  );
  assertEquals(asPull.kind, "pull_request");
});

Deno.test("issue 82 provider reads: readIssueDetail reports a missing summary, parent or body as unknown or empty and refuses malformed ones", async () => {
  const read = (wire: Record<string, unknown>) =>
    clientFor(() => Response.json(wire)).readIssueDetail(
      { token: "t", fullName: "o/r", number: 7 },
      signal(),
    );
  // GitHub omitting the summaries is unknown (null), never zero.
  const bare = await read(ISSUE_WIRE);
  assert(bare.kind === "issue");
  assertEquals(
    [
      bare.subIssuesTotal,
      bare.blockedByTotal,
      bare.blockingTotal,
      bare.repositoryPrivate,
      bare.parent,
    ],
    [null, null, null, null, null],
  );
  const partial = await read({
    ...ISSUE_WIRE,
    body: null,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    issue_dependencies_summary: { total_blocking: 3 },
    parent_issue_url: "https://api.github.com/repos/o/r/issues/3",
    repository: { private: false },
  });
  assert(partial.kind === "issue");
  assertEquals(partial.body, "");
  assertEquals(partial.bodyTooLarge, false);
  assertEquals(partial.subIssuesTotal, 0);
  assertEquals(partial.blockedByTotal, null);
  assertEquals(partial.blockingTotal, 3);
  assertEquals(partial.parent, { repositoryFullName: "o/r", number: 3 });
  assertEquals(partial.repositoryPrivate, false);
  // A key present under any value marks a pull request.
  assertEquals(
    (await read({ ...ISSUE_WIRE, pull_request: null })).kind,
    "pull_request",
  );
  for (
    const [label, wire] of [
      ["parent on another host", {
        ...ISSUE_WIRE,
        parent_issue_url: "https://example.com/repos/o/r/issues/3",
      }],
      ["parent that is not an issue URL", {
        ...ISSUE_WIRE,
        parent_issue_url: "https://api.github.com/repos/o/r/pulls/3",
      }],
      ["parent number zero", {
        ...ISSUE_WIRE,
        parent_issue_url: "https://api.github.com/repos/o/r/issues/0",
      }],
      ["parent number with a leading zero", {
        ...ISSUE_WIRE,
        parent_issue_url: "https://api.github.com/repos/o/r/issues/03",
      }],
      ["parent repository traversal", {
        ...ISSUE_WIRE,
        parent_issue_url: "https://api.github.com/repos/o/../issues/3",
      }],
      ["missing title", { ...ISSUE_WIRE, title: undefined }],
      ["numeric title", { ...ISSUE_WIRE, title: 5 }],
      ["unknown state", { ...ISSUE_WIRE, state: "merged" }],
      ["negative summary", {
        ...ISSUE_WIRE,
        sub_issues_summary: { total: -1 },
      }],
      ["fractional summary", {
        ...ISSUE_WIRE,
        issue_dependencies_summary: { total_blocking: 1.5 },
      }],
      ["non-boolean visibility", {
        ...ISSUE_WIRE,
        repository: { private: "yes" },
      }],
      ["not an object", [ISSUE_WIRE]],
    ] as [string, Record<string, unknown>][]
  ) {
    await assertUnavailable(() => read(wire), label);
  }
});

Deno.test("issue 82 provider reads: a title is cut to 500 units without splitting a surrogate pair and label names stay bounded", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1 }, { number: 2 }, {
    number: 3,
    labels: Array.from(
      { length: GITHUB_MAX_LABELS + 5 },
      (_, index) => `${index}`.padEnd(GITHUB_MAX_LABEL_LENGTH + 10, "x"),
    ),
  }, { number: 4 }]);
  const title = async (number: number, text: string) => {
    github.seedIssueDetail(repository.id, number, { title: text });
    const issue = await github.client.readIssueDetail(
      { token, fullName, number },
      signal(),
    );
    assert(issue.kind === "issue");
    return issue.title;
  };
  assertEquals(GITHUB_MAX_ISSUE_TITLE_LENGTH, 500);
  assertEquals(await title(1, "t".repeat(500)), "t".repeat(500));
  assertEquals(await title(1, "t".repeat(501)), "t".repeat(500));
  assertEquals(await title(1, "t".repeat(5_000)), "t".repeat(500));
  // 250 emoji are exactly 500 units and kept whole.
  assertEquals(await title(2, "😀".repeat(250)), "😀".repeat(250));
  // The 500th unit would be the first half of the 250th emoji: dropped, 499 units.
  const split = await title(2, `a${"😀".repeat(300)}`);
  assertEquals(split, `a${"😀".repeat(249)}`);
  assertEquals(split.length, 499);
  assertEquals(await title(4, ""), "");
  const labelled = await github.client.readIssueDetail(
    { token, fullName, number: 3 },
    signal(),
  );
  assert(labelled.kind === "issue");
  assertEquals(labelled.labels.length, GITHUB_MAX_LABELS);
  assert(
    labelled.labels.every((label) => label.length === GITHUB_MAX_LABEL_LENGTH),
  );
  // The cut is never silent: the read says the list is only a prefix.
  assertEquals(labelled.labelsTruncated, true);
});

Deno.test("issue 82 provider reads: a label list past the bound is flagged, so a hold label past position 50 is never read as absent", async () => {
  const { github, repository, fullName, token } = await fixture();
  const areas = (count: number) =>
    Array.from({ length: count }, (_, index) => `area-${index + 1}`);
  github.seedIssues(repository.id, [
    // Exactly the bound: every label is kept and the list is complete.
    { number: 1, labels: areas(GITHUB_MAX_LABELS) },
    // One past the bound, the hold label first: kept, but the list is cut.
    { number: 2, labels: ["bakery:hold", ...areas(GITHUB_MAX_LABELS)] },
    // The hold and execute labels sit past position 50: dropped from
    // `labels`, which is why the flag must say so.
    {
      number: 3,
      labels: [...areas(GITHUB_MAX_LABELS), "bakery:hold", "ready for agent"],
    },
    { number: 4, labels: [] },
  ]);
  const read = async (number: number) => {
    const issue = await github.client.readIssueDetail(
      { token, fullName, number },
      signal(),
    );
    assert(issue.kind === "issue");
    return issue;
  };
  const exact = await read(1);
  assertEquals(exact.labels, areas(GITHUB_MAX_LABELS));
  assertEquals(exact.labelsTruncated, false);
  const holdFirst = await read(2);
  assertEquals(holdFirst.labels.length, GITHUB_MAX_LABELS);
  assertEquals(holdFirst.labels[0], "bakery:hold");
  assertEquals(holdFirst.labelsTruncated, true);
  const past = await read(3);
  assertEquals(past.labels, areas(GITHUB_MAX_LABELS));
  assert(!past.labels.includes("bakery:hold"));
  assertEquals(past.labelsTruncated, true);
  assertEquals((await read(4)).labelsTruncated, false);

  // The flag counts the wire list, whichever shape its items have.
  const wire = (labels: unknown[]) =>
    clientFor(() => Response.json({ ...ISSUE_WIRE, labels }))
      .readIssueDetail({ token: "t", fullName: "o/r", number: 7 }, signal());
  const strings = await wire(
    Array.from({ length: GITHUB_MAX_LABELS + 1 }, (_, index) => `s${index}`),
  );
  assert(strings.kind === "issue");
  assertEquals(strings.labels.length, GITHUB_MAX_LABELS);
  assertEquals(strings.labelsTruncated, true);
  const few = await wire(["a", { name: "b" }]);
  assert(few.kind === "issue");
  assertEquals([few.labels, few.labelsTruncated], [["a", "b"], false]);
});

Deno.test("issue 82 provider reads: a body of 65,536 code points is kept whole, one more sets bodyTooLarge and keeps no text", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1 }]);
  const body = async (text: string | null) => {
    github.seedIssueDetail(repository.id, 1, { body: text });
    const issue = await github.client.readIssueDetail(
      { token, fullName, number: 1 },
      signal(),
    );
    assert(issue.kind === "issue");
    return issue;
  };
  assertEquals(GITHUB_MAX_ISSUE_BODY_CODE_POINTS, 65_536);
  // Four-byte, two-unit characters: 131,072 UTF-16 units but 65,536 code points.
  const astral = "😀".repeat(65_536);
  assertEquals(astral.length, 131_072);
  const kept = await body(astral);
  assertEquals(kept.bodyTooLarge, false);
  assertEquals(kept.body, astral);
  const tooLarge = await body("😀".repeat(65_537));
  assertEquals(tooLarge.bodyTooLarge, true);
  assertEquals(tooLarge.body, "");
  // Two-byte characters, one unit each.
  const wide = "é".repeat(65_536);
  assertEquals((await body(wide)).body, wide);
  assertEquals((await body("é".repeat(65_537))).bodyTooLarge, true);
  // ASCII, one unit each, and a mix whose unit length is above the bound
  // while its code point count is below it.
  assertEquals((await body("a".repeat(65_536))).bodyTooLarge, false);
  assertEquals((await body("a".repeat(65_537))).bodyTooLarge, true);
  const mixed = `${"😀".repeat(1_000)}${"a".repeat(65_536 - 1_000)}`;
  assert(mixed.length > 65_536);
  const mixedRead = await body(mixed);
  assertEquals(mixedRead.bodyTooLarge, false);
  assertEquals(mixedRead.body, mixed);
  assertEquals((await body(`${mixed}a`)).bodyTooLarge, true);
  // Lone surrogates count as one code point each.
  assertEquals((await body("\ud800".repeat(65_536))).bodyTooLarge, false);
  assertEquals((await body("\ud800".repeat(65_537))).bodyTooLarge, true);
  // An empty or null body is empty text, not too large.
  for (const empty of ["", null]) {
    const read = await body(empty);
    assertEquals([read.body, read.bodyTooLarge], ["", false]);
  }
  // The oversized body's text appears nowhere in what the client returns.
  assert(!JSON.stringify(tooLarge).includes("😀"));
});

Deno.test("issue 82 provider reads: an issue answer is read up to 524,288 bytes and a larger one is a dependency failure", async () => {
  assertEquals(MAX_ISSUE_DETAIL_BYTES, 524_288);
  const respondWith = (text: string) =>
    clientFor(() =>
      new Response(JSON.stringify({ ...ISSUE_WIRE, body: text }), {
        headers: { "content-type": "application/json" },
      })
    );
  const read = (client: GitHubAppClient) =>
    client.readIssueDetail(
      { token: "t", fullName: "o/r", number: 7 },
      signal(),
    );
  const overhead = JSON.stringify({ ...ISSUE_WIRE, body: "" }).length;
  // The largest body the byte bound lets through, then one byte past it.
  const fits = MAX_ISSUE_DETAIL_BYTES - overhead;
  const tooMany = await read(respondWith("a".repeat(fits)));
  assert(tooMany.kind === "issue");
  // Within the byte bound but past the code point bound: reported, no text.
  assertEquals(tooMany.bodyTooLarge, true);
  assertEquals(tooMany.body, "");
  await assertUnavailable(
    () => read(respondWith("a".repeat(fits + 1))),
    "one byte past the bound",
  );
  // The single-issue read keeps its 1 MiB bound; the detail read has its own.
  await assertUnavailable(
    () => read(respondWith("a".repeat(1_048_576))),
    "one MiB",
  );
});

/**
 * A JSON page of `wire` whose text is exactly `bytes` bytes. The padding sits
 * in a field the client's schema drops, so a page that fits reads as one item.
 */
function pageOfBytes(wire: Record<string, unknown>, bytes: number): string {
  const overhead = JSON.stringify([{ ...wire, padding: "" }]).length;
  const text = JSON.stringify([
    { ...wire, padding: "a".repeat(bytes - overhead) },
  ]);
  assertEquals(new TextEncoder().encode(text).byteLength, bytes);
  return text;
}

/** The page reads of the ticket reader, with the byte bound each client method keeps. */
const PAGE_CAPS: {
  read: string;
  cap: number;
  wire: Record<string, unknown>;
  call: (client: GitHubAppClient) => Promise<{ items: unknown[] }>;
}[] = [
  {
    read: "listBlockedBy",
    cap: 8_388_608,
    wire: BLOCKER_WIRE,
    call: (client) =>
      client.listBlockedBy(
        { token: "t", fullName: "o/r", number: 5, page: 1 },
        signal(),
      ),
  },
  {
    read: "listIssueEvents",
    cap: 4_194_304,
    wire: EVENT_WIRE,
    call: (client) =>
      client.listIssueEvents(
        { token: "t", fullName: "o/r", number: 5, page: 1 },
        signal(),
      ),
  },
  {
    read: "listCommitPullRequests",
    cap: 4_194_304,
    wire: PULL_WIRE,
    call: (client) =>
      client.listCommitPullRequests(
        { token: "t", fullName: "o/r", sha: SHA, page: 1 },
        signal(),
      ),
  },
];

for (const { read, cap, wire, call } of PAGE_CAPS) {
  Deno.test(`issue 82 provider reads: ${read} reads a page of exactly ${cap.toLocaleString("en-US")} bytes and a page one byte larger is a dependency failure`, async () => {
    const respondWith = (text: string) =>
      clientFor(() =>
        new Response(text, { headers: { "content-type": "application/json" } })
      );
    // The bound is pinned by its number, not by the constant the client keeps.
    const fits = await call(respondWith(pageOfBytes(wire, cap)));
    assertEquals(fits.items.length, 1);
    await assertUnavailable(
      () => call(respondWith(pageOfBytes(wire, cap + 1))),
      "one byte past the bound",
    );
    // A page well inside the bound reads the same, so the pair above is the edge.
    assertEquals(
      (await call(respondWith(pageOfBytes(wire, cap / 2)))).items,
      fits.items,
    );
  });
}

Deno.test("issue 82 provider reads: readIssueDetail maps 301 and 308 to moved, 404 and 410 to gone, nothing else to absent", async () => {
  const { github, repository, other, fullName, otherFullName, token } =
    await fixture();
  github.seedIssues(repository.id, [{ number: 1 }, { number: 2 }, {
    number: 3,
  }]);
  github.deleteIssue(repository.id, 2);
  github.transferIssue(repository.id, 3);
  const detail = (number: number, name = fullName) =>
    github.client.readIssueDetail({ token, fullName: name, number }, signal());
  assertEquals((await detail(1)).kind, "issue");
  assertEquals(await detail(2), { kind: "gone" });
  assertEquals(await detail(3), { kind: "moved" });
  assertEquals(await detail(99), { kind: "gone" });
  // Another repository of the installation is hidden from this token: 404.
  assertEquals(await detail(1, otherFullName), { kind: "gone" });
  assert(other.id !== repository.id);
  for (
    const [status, expected] of [
      [301, "moved"],
      [308, "moved"],
      [404, "gone"],
      [410, "gone"],
    ] as const
  ) {
    const client = clientFor(() =>
      new Response(null, { status, headers: { location: "https://x.test/" } })
    );
    for (const read of READS) {
      if (
        read.name !== "readIssueDetail" &&
        read.name !== "readCollaboratorPermission"
      ) continue;
      assertEquals(
        await read.call(client, GOOD_INPUT),
        { kind: expected },
        `${read.name} ${status}`,
      );
    }
  }
  // A status that is not an absent one is a dependency failure, not "gone".
  for (const status of [400, 409, 422, 500, 502]) {
    const client = clientFor(() => Response.json({}, { status }));
    for (const read of READS) {
      await assertUnavailable(
        () => read.call(client, GOOD_INPUT),
        `${read.name} ${status}`,
      );
    }
  }
});

Deno.test("issue 82 provider reads: listBlockedBy pages 100 at a time and names each blocker's repository", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1 }]);
  const first = github.seedBlockedBy(repository.id, 1, [
    { number: 2 },
    {
      number: 9,
      repositoryFullName: "other-org/other-repo",
      state: "closed",
      stateReason: "completed",
    },
    { number: 4, state: "closed", stateReason: "not_planned" },
  ]);
  assertEquals(first.length, 3);
  assertEquals(
    await github.client.listBlockedBy(
      { token, fullName, number: 1, page: 1 },
      signal(),
    ),
    {
      items: [
        {
          id: first[0].id,
          number: 2,
          state: "open",
          stateReason: null,
          repositoryFullName: fullName,
        },
        {
          id: first[1].id,
          number: 9,
          state: "closed",
          stateReason: "completed",
          repositoryFullName: "other-org/other-repo",
        },
        {
          id: first[2].id,
          number: 4,
          state: "closed",
          stateReason: "not_planned",
          repositoryFullName: fullName,
        },
      ],
      hasNext: false,
    },
  );
  // 101 blockers: the 101st is on a second page that page one points to.
  github.seedBlockedBy(
    repository.id,
    1,
    Array.from({ length: 101 }, (_, index) => ({ number: 100 + index })),
  );
  const page1 = await github.client.listBlockedBy(
    { token, fullName, number: 1, page: 1 },
    signal(),
  );
  assertEquals(page1.items.length, 100);
  assertEquals(page1.hasNext, true);
  assertEquals(page1.items[0].number, 100);
  assertEquals(page1.items[99].number, 199);
  const page2 = await github.client.listBlockedBy(
    { token, fullName, number: 1, page: 2 },
    signal(),
  );
  assertEquals(page2.items.map((item) => item.number), [200]);
  assertEquals(page2.hasNext, false);
  // The issue's dependency summary counts what the list holds.
  const detail = await github.client.readIssueDetail(
    { token, fullName, number: 1 },
    signal(),
  );
  assert(detail.kind === "issue");
  assertEquals(detail.blockedByTotal, 101);
  // A page past the end is empty; an issue with no blockers is an empty page.
  const beyond = await github.client.listBlockedBy(
    { token, fullName, number: 1, page: 3 },
    signal(),
  );
  assertEquals(beyond, { items: [], hasNext: false });
  github.seedIssues(repository.id, [{ number: 2 }]);
  assertEquals(
    await github.client.listBlockedBy(
      { token, fullName, number: 2, page: 1 },
      signal(),
    ),
    { items: [], hasNext: false },
  );
});

Deno.test("issue 82 provider reads: listBlockedBy derives the repository from repository_url, falls back to the repository object and refuses a blocker with neither", async () => {
  const page = (items: Record<string, unknown>[]) =>
    clientFor(() => Response.json(items)).listBlockedBy(
      { token: "t", fullName: "o/r", number: 5, page: 1 },
      signal(),
    );
  const [viaUrl] = (await page([BLOCKER_WIRE])).items;
  assertEquals(viaUrl.repositoryFullName, "o/r");
  const { repository_url: _url, ...withoutUrl } = BLOCKER_WIRE;
  const [viaObject] = (await page([
    { ...withoutUrl, repository: { full_name: "x/y" } },
  ])).items;
  assertEquals(viaObject.repositoryFullName, "x/y");
  // The URL decides when both are present.
  const [both] = (await page([
    { ...BLOCKER_WIRE, repository: { full_name: "x/y" } },
  ])).items;
  assertEquals(both.repositoryFullName, "o/r");
  assertEquals(
    (await page([{ ...BLOCKER_WIRE, state_reason: undefined }])).items[0]
      .stateReason,
    null,
  );
  for (
    const [label, items] of [
      ["neither", [withoutUrl]],
      ["null repository object", [{ ...withoutUrl, repository: null }]],
      ["url on another host", [{
        ...BLOCKER_WIRE,
        repository_url: "https://example.com/repos/o/r",
      }]],
      ["url with a trailing path", [{
        ...BLOCKER_WIRE,
        repository_url: "https://api.github.com/repos/o/r/issues",
      }]],
      ["url naming a dot segment", [{
        ...BLOCKER_WIRE,
        repository_url: "https://api.github.com/repos/o/..",
      }]],
      ["a bad url is not rescued by a good object", [{
        ...BLOCKER_WIRE,
        repository_url: "https://example.com/repos/o/r",
        repository: { full_name: "x/y" },
      }]],
      ["url above 2048 characters", [{
        ...BLOCKER_WIRE,
        repository_url: `https://api.github.com/repos/o/${"r".repeat(2_100)}`,
      }]],
      ["unknown state", [{ ...BLOCKER_WIRE, state: "merged" }]],
      ["zero number", [{ ...BLOCKER_WIRE, number: 0 }]],
      ["101 items", Array.from({ length: 101 }, () => BLOCKER_WIRE)],
      ["not a list", { ...BLOCKER_WIRE }],
    ] as [string, unknown][]
  ) {
    await assertUnavailable(
      () => page(items as Record<string, unknown>[]),
      label,
    );
  }
  assertEquals(
    (await page(Array.from({ length: 100 }, () => BLOCKER_WIRE))).items.length,
    100,
  );
});

Deno.test("issue 82 provider reads: listIssueEvents keeps only labeled, unlabeled and closed events with their actor, label and closing commit", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1 }, { number: 2 }]);
  const commit = fakeCommitSha();
  const at = (seconds: number) =>
    fakeTimestamp(Date.UTC(2026, 9, 30, 12, 0, seconds));
  const labeled = github.seedIssueEvent(repository.id, 1, {
    event: "labeled",
    label: "ready for agent",
    actor: { id: 5, login: "octocat" },
    createdAt: at(0),
    // A commit on a label event is not a closing commit.
    commitId: SHA,
  });
  github.seedIssueEvent(repository.id, 1, {
    event: "referenced",
    commitId: SHA,
    createdAt: at(1),
  });
  github.seedIssueEvent(repository.id, 1, {
    event: "assigned",
    createdAt: at(2),
  });
  const unlabeled = github.seedIssueEvent(repository.id, 1, {
    event: "unlabeled",
    label: "bakery:hold",
    actor: { id: 6, login: "dependabot[bot]" },
    createdAt: at(3),
  });
  const ghost = github.seedIssueEvent(repository.id, 1, {
    event: "labeled",
    label: "ready for agent",
    actor: null,
    createdAt: at(4),
  });
  github.seedIssueEvent(repository.id, 1, {
    event: "subscribed",
    createdAt: at(5),
  });
  const closedByCommit = github.seedIssueEvent(repository.id, 1, {
    event: "closed",
    actor: { id: 7, login: "merger" },
    commitId: commit,
    createdAt: at(6),
  });
  const closedByHand = github.seedIssueEvent(repository.id, 1, {
    event: "closed",
    createdAt: at(7),
  });
  assertEquals(
    await github.client.listIssueEvents(
      { token, fullName, number: 1, page: 1 },
      signal(),
    ),
    {
      items: [
        {
          id: labeled.id,
          event: "labeled",
          labelName: "ready for agent",
          actor: { id: 5, login: "octocat" },
          commitId: null,
          createdAt: at(0),
        },
        {
          id: unlabeled.id,
          event: "unlabeled",
          labelName: "bakery:hold",
          actor: { id: 6, login: "dependabot[bot]" },
          commitId: null,
          createdAt: at(3),
        },
        {
          id: ghost.id,
          event: "labeled",
          labelName: "ready for agent",
          actor: null,
          commitId: null,
          createdAt: at(4),
        },
        {
          id: closedByCommit.id,
          event: "closed",
          labelName: null,
          actor: { id: 7, login: "merger" },
          commitId: commit,
          createdAt: at(6),
        },
        {
          id: closedByHand.id,
          event: "closed",
          labelName: null,
          actor: { id: 1, login: "octocat" },
          commitId: null,
          createdAt: at(7),
        },
      ],
      hasNext: false,
    },
  );
  // The client keeps GitHub's order; ordering by time is the caller's job.
  const shuffled = [at(9), at(8), at(10)];
  for (const createdAt of shuffled) {
    github.seedIssueEvent(repository.id, 2, {
      event: "labeled",
      label: "x",
      createdAt,
    });
  }
  assertEquals(
    (await github.client.listIssueEvents(
      { token, fullName, number: 2, page: 1 },
      signal(),
    )).items.map((event) => event.createdAt),
    shuffled,
  );
  // An issue with no events is an empty page.
  github.seedIssues(repository.id, [{ number: 3 }]);
  assertEquals(
    await github.client.listIssueEvents(
      { token, fullName, number: 3, page: 1 },
      signal(),
    ),
    { items: [], hasNext: false },
  );
});

Deno.test("issue 82 provider reads: a close past the first 100 events is found by paging, and a page of other events keeps nothing but still points on", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1 }, { number: 2 }]);
  for (let index = 0; index < 120; index++) {
    github.seedIssueEvent(repository.id, 1, {
      event: "labeled",
      label: `label-${index}`,
    });
  }
  const commit = fakeCommitSha();
  github.seedIssueEvent(repository.id, 1, {
    event: "closed",
    commitId: commit,
  });
  const page = (n: number, page: number) =>
    github.client.listIssueEvents(
      { token, fullName, number: n, page },
      signal(),
    );
  const first = await page(1, 1);
  assertEquals(first.items.length, 100);
  assertEquals(first.hasNext, true);
  assert(first.items.every((event) => event.event === "labeled"));
  const second = await page(1, 2);
  assertEquals(second.hasNext, false);
  assertEquals(second.items.length, 21);
  const closed = second.items.filter((event) => event.event === "closed");
  assertEquals(closed.map((event) => event.commitId), [commit]);
  assertEquals(second.items[0].labelName, "label-100");
  // 100 events of other kinds, then a close: the first page is empty after
  // filtering but hasNext is what says another page exists.
  for (let index = 0; index < 100; index++) {
    github.seedIssueEvent(repository.id, 2, { event: "referenced" });
  }
  github.seedIssueEvent(repository.id, 2, {
    event: "closed",
    commitId: commit,
  });
  const filtered = await page(2, 1);
  assertEquals(filtered, { items: [], hasNext: true });
  assertEquals((await page(2, 2)).items.map((event) => event.commitId), [
    commit,
  ]);
});

Deno.test("issue 82 provider reads: listIssueEvents drops unknown kinds whatever their shape and refuses a malformed kept event", async () => {
  const page = (items: unknown) =>
    clientFor(() => Response.json(items)).listIssueEvents(
      { token: "t", fullName: "o/r", number: 5, page: 1 },
      signal(),
    );
  // Unknown kinds are dropped before their fields are looked at.
  assertEquals(
    (await page([
      { event: "weird", id: "not-a-number", actor: 5, label: [] },
      { event: "milestoned", milestone: { title: "m" } },
      EVENT_WIRE,
    ])).items.map((event) => event.id),
    [41],
  );
  // Absent or null actor is an explicit null; a label name is cut to the label bound.
  const { actor: _actor, ...noActor } = EVENT_WIRE;
  const [bare] = (await page([noActor])).items;
  assertEquals(bare.actor, null);
  const [long] = (await page([
    { ...EVENT_WIRE, label: { name: "n".repeat(80) } },
  ])).items;
  assertEquals(long.labelName, "n".repeat(GITHUB_MAX_LABEL_LENGTH));
  // A closed event needs no label; a closing commit must be a full SHA.
  const [closed] = (await page([
    {
      id: 2,
      event: "closed",
      actor: null,
      commit_id: SHA,
      created_at: "2026-10-31T12:00:00Z",
    },
  ])).items;
  assertEquals([closed.labelName, closed.commitId], [null, SHA]);
  for (
    const [label, items] of [
      ["no kind", [{ id: 1 }]],
      ["a string entry", ["labeled"]],
      ["a null entry", [null]],
      ["a numeric kind", [{ ...EVENT_WIRE, event: 5 }]],
      ["labeled without a label", [{ ...EVENT_WIRE, label: undefined }]],
      ["unlabeled with a null label", [{
        ...EVENT_WIRE,
        event: "unlabeled",
        label: null,
      }]],
      ["an empty label name", [{ ...EVENT_WIRE, label: { name: "" } }]],
      ["a zero event id", [{ ...EVENT_WIRE, id: 0 }]],
      ["a zero actor id", [{ ...EVENT_WIRE, actor: { id: 0, login: "x" } }]],
      ["an empty actor login", [{
        ...EVENT_WIRE,
        actor: { id: 1, login: "" },
      }]],
      ["a short closing commit", [{
        ...EVENT_WIRE,
        event: "closed",
        commit_id: "abc",
      }]],
      ["an uppercase closing commit", [{
        ...EVENT_WIRE,
        event: "closed",
        commit_id: "A".repeat(40),
      }]],
      ["a time without an offset", [{
        ...EVENT_WIRE,
        created_at: "2026-10-31T12:00:00",
      }]],
      ["101 events", Array.from({ length: 101 }, () => EVENT_WIRE)],
      ["not a list", EVENT_WIRE],
    ] as [string, unknown][]
  ) {
    await assertUnavailable(() => page(items), label);
  }
  assertEquals(
    (await page(Array.from({ length: 100 }, () => EVENT_WIRE))).items.length,
    100,
  );
});

Deno.test("issue 82 provider reads: listCommitPullRequests maps merge state from merged_at and keeps a test merge commit out of mergeCommitSha", async () => {
  const { github, repository, fullName, token } = await fixture();
  const mergeSha = fakeCommitSha();
  const mergedAt = "2026-10-30T09:30:00Z";
  github.seedCommitPull(repository.id, SHA, {
    number: 11,
    mergedAt,
    mergeCommitSha: mergeSha,
  });
  github.seedCommitPull(repository.id, SHA, { number: 12 });
  github.seedCommitPull(repository.id, SHA, {
    number: 13,
    mergedAt,
    baseRef: "release/1.0",
  });
  github.seedCommitPull(repository.id, SHA, { number: 14, state: "closed" });
  const page = await github.client.listCommitPullRequests(
    { token, fullName, sha: SHA, page: 1 },
    signal(),
  );
  assertEquals(page.hasNext, false);
  assertEquals(page.items.length, 4);
  assertEquals(page.items[0], {
    number: 11,
    merged: true,
    mergedAt,
    mergeCommitSha: mergeSha,
    baseRef: "main",
  });
  // Open: the wire carries a test merge commit, which is not recorded.
  assertEquals(page.items[1], {
    number: 12,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    baseRef: "main",
  });
  assertEquals(page.items[2].baseRef, "release/1.0");
  assertEquals(page.items[2].merged, true);
  assert(/^[0-9a-f]{40}$/.test(page.items[2].mergeCommitSha ?? ""));
  // Closed without a merge is not merged.
  assertEquals(page.items[3].merged, false);
  // A commit with no pull request is an empty list; 101 pull requests page.
  assertEquals(
    await github.client.listCommitPullRequests(
      { token, fullName, sha: UNSEEDED_SHA, page: 1 },
      signal(),
    ),
    { items: [], hasNext: false },
  );
  const many = "c".repeat(40);
  for (let index = 0; index < 101; index++) {
    github.seedCommitPull(repository.id, many, { number: 100 + index });
  }
  const first = await github.client.listCommitPullRequests(
    { token, fullName, sha: many, page: 1 },
    signal(),
  );
  assertEquals([first.items.length, first.hasNext], [100, true]);
  const second = await github.client.listCommitPullRequests(
    { token, fullName, sha: many, page: 2 },
    signal(),
  );
  assertEquals([second.items.map((pull) => pull.number), second.hasNext], [[
    200,
  ], false]);
});

Deno.test("issue 82 provider reads: listCommitPullRequests reads merged_at, not a merged flag, and refuses a malformed pull request", async () => {
  const page = (items: unknown) =>
    clientFor(() => Response.json(items)).listCommitPullRequests(
      { token: "t", fullName: "o/r", sha: SHA, page: 1 },
      signal(),
    );
  // A merged flag with no merged_at is not merged; merged_at with no commit is merged without one.
  const [flagOnly] = (await page([
    { ...PULL_WIRE, merged_at: null, merged: true },
  ])).items;
  assertEquals([flagOnly.merged, flagOnly.mergeCommitSha], [false, null]);
  const [noCommit] =
    (await page([{ ...PULL_WIRE, merge_commit_sha: null }])).items;
  assertEquals([noCommit.merged, noCommit.mergeCommitSha], [true, null]);
  const { merged_at: _mergedAt, ...absentMergedAt } = PULL_WIRE;
  assertEquals((await page([absentMergedAt])).items[0].merged, false);
  for (
    const [label, items] of [
      ["no base", [{ ...PULL_WIRE, base: undefined }]],
      ["an empty base ref", [{ ...PULL_WIRE, base: { ref: "" } }]],
      ["a base ref above 255", [{
        ...PULL_WIRE,
        base: { ref: "r".repeat(256) },
      }]],
      ["a zero number", [{ ...PULL_WIRE, number: 0 }]],
      ["a bad merge time", [{ ...PULL_WIRE, merged_at: "yesterday" }]],
      ["a short merge commit", [{ ...PULL_WIRE, merge_commit_sha: "abc" }]],
      ["101 items", Array.from({ length: 101 }, () => PULL_WIRE)],
      ["not a list", PULL_WIRE],
    ] as [string, unknown][]
  ) {
    await assertUnavailable(() => page(items), label);
  }
});

Deno.test("issue 82 provider reads: readCollaboratorPermission returns the user id and permission, gone for a user GitHub does not know", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedCollaborator(repository.id, "Octocat", {
    id: 5,
    permission: "write",
  });
  github.seedCollaborator(repository.id, "root", {
    id: 6,
    permission: "admin",
  });
  github.seedCollaborator(repository.id, "reader", {
    id: 7,
    permission: "read",
  });
  github.seedCollaborator(repository.id, "stranger", {
    id: 8,
    permission: "none",
  });
  const permission = (login: string) =>
    github.client.readCollaboratorPermission(
      { token, fullName, login },
      signal(),
    );
  assertEquals(await permission("Octocat"), {
    kind: "present",
    userId: 5,
    permission: "write",
  });
  // Logins are case-insensitive on GitHub.
  assertEquals(await permission("octocat"), {
    kind: "present",
    userId: 5,
    permission: "write",
  });
  assertEquals(await permission("root"), {
    kind: "present",
    userId: 6,
    permission: "admin",
  });
  assertEquals(await permission("reader"), {
    kind: "present",
    userId: 7,
    permission: "read",
  });
  // A user with no access exists and has permission none; an unknown user is 404.
  assertEquals(await permission("stranger"), {
    kind: "present",
    userId: 8,
    permission: "none",
  });
  assertEquals(await permission("nobody"), { kind: "gone" });
  const respond = (wire: unknown) =>
    clientFor(() => Response.json(wire)).readCollaboratorPermission(
      { token: "t", fullName: "o/r", login: "octocat" },
      signal(),
    );
  assertEquals(await respond(PERMISSION_WIRE), {
    kind: "present",
    userId: 5,
    permission: "write",
  });
  for (
    const [label, wire] of [
      ["an unknown permission", { ...PERMISSION_WIRE, permission: "triage" }],
      ["no user", { permission: "write" }],
      ["a null user", { ...PERMISSION_WIRE, user: null }],
      ["a zero user id", { ...PERMISSION_WIRE, user: { id: 0 } }],
      ["a non-numeric user id", { ...PERMISSION_WIRE, user: { id: "5" } }],
      ["no permission", { user: PERMISSION_WIRE.user }],
      ["a list", [PERMISSION_WIRE]],
    ] as [string, unknown][]
  ) {
    await assertUnavailable(() => respond(wire), label);
  }
});

Deno.test("issue 82 provider reads: readRepositoryIdentity reports the default branch only when asked and leaves the plain answer as it was", async () => {
  const { github, repository, fullName, token } = await fixture();
  assertEquals(
    await github.client.readRepositoryIdentity({ token, fullName }, signal()),
    { kind: "present", id: repository.id },
  );
  assertEquals(
    await github.client.readRepositoryIdentity(
      { token, fullName, withDefaultBranch: true },
      signal(),
    ),
    { kind: "present", id: repository.id, defaultBranch: "main" },
  );
  const answer = (wire: unknown) => clientFor(() => Response.json(wire));
  const plain = (client: GitHubAppClient) =>
    client.readRepositoryIdentity({ token: "t", fullName: "o/r" }, signal());
  const asked = (client: GitHubAppClient) =>
    client.readRepositoryIdentity(
      { token: "t", fullName: "o/r", withDefaultBranch: true },
      signal(),
    );
  // A repository whose default_branch is missing or odd still reads for a
  // caller that did not ask, and fails closed for one that did.
  for (
    const [label, wire] of [
      ["missing", { id: 5 }],
      ["empty", { id: 5, default_branch: "" }],
      ["numeric", { id: 5, default_branch: 1 }],
      ["above 255 characters", { id: 5, default_branch: "b".repeat(256) }],
      ["null", { id: 5, default_branch: null }],
    ] as [string, unknown][]
  ) {
    assertEquals(await plain(answer(wire)), { kind: "present", id: 5 }, label);
    await assertUnavailable(() => asked(answer(wire)), label);
  }
  assertEquals(
    await asked(answer({ id: 5, default_branch: "b".repeat(255) })),
    { kind: "present", id: 5, defaultBranch: "b".repeat(255) },
  );
  // Absent statuses keep their meaning with the flag set.
  assertEquals(
    await asked(clientFor(() => new Response(null, { status: 404 }))),
    { kind: "gone" },
  );
  assertEquals(
    await asked(clientFor(() => new Response(null, { status: 301 }))),
    { kind: "moved" },
  );
});

Deno.test("issue 82 provider reads: the request path and query are built from validated inputs and the token travels only in the Authorization header", async () => {
  const token = "ghs_path-test-token-1f4a";
  const requests: Request[] = [];
  const client = clientFor(() => new Response(null, { status: 404 }), requests);
  const base = { token, fullName: "o/r" };
  // Absent statuses make these four succeed with "gone"; the lists throw.
  await client.readIssueDetail({ ...base, number: 12 }, signal());
  await client.readCollaboratorPermission(
    { ...base, login: "Octo-Cat" },
    signal(),
  );
  for (
    const call of [
      () => client.listBlockedBy({ ...base, number: 12, page: 3 }, signal()),
      () => client.listIssueEvents({ ...base, number: 12, page: 2 }, signal()),
      () =>
        client.listCommitPullRequests({ ...base, sha: SHA, page: 4 }, signal()),
    ]
  ) await assertUnavailable(call, "404 on a list");
  assertEquals(requests.map((request) => request.url), [
    "https://api.github.com/repos/o/r/issues/12",
    "https://api.github.com/repos/o/r/collaborators/Octo-Cat/permission",
    "https://api.github.com/repos/o/r/issues/12/dependencies/blocked_by?per_page=100&page=3",
    "https://api.github.com/repos/o/r/issues/12/events?per_page=100&page=2",
    `https://api.github.com/repos/o/r/commits/${SHA}/pulls?per_page=100&page=4`,
  ]);
  for (const request of requests) {
    assertEquals(request.method, "GET");
    assertEquals(request.body, null);
    assertEquals(request.headers.get("authorization"), `Bearer ${token}`);
    assertEquals(request.headers.get("accept"), "application/vnd.github+json");
    assertEquals(request.headers.get("x-github-api-version"), "2026-03-10");
    assert(!request.url.includes(token));
    assert(
      [...request.headers].every(([name, value]) =>
        name === "authorization" || !value.includes(token)
      ),
    );
  }
  // A login that carries path characters in a case-insensitive spelling is never altered.
  const upper = clientFor(() => new Response(null, { status: 404 }), requests);
  await upper.readCollaboratorPermission(
    { ...base, login: "A".repeat(39) },
    signal(),
  );
  assertEquals(
    requests.at(-1)?.url,
    `https://api.github.com/repos/o/r/collaborators/${
      "A".repeat(39)
    }/permission`,
  );
});

const BAD_NUMBERS: unknown[] = [
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  2 ** 53,
  "5",
  null,
  undefined,
  true,
  {},
];
const BAD_INPUTS: Record<keyof typeof GOOD_INPUT, unknown[]> = {
  token: ["", "x".repeat(4_097), undefined, null, 5, {}],
  fullName: [
    "",
    "o",
    "o/r/x",
    "../r",
    "o/..",
    "o/.",
    "o/r?x=1",
    "o/r#x",
    "o /r",
    "o/r\n",
    "/r",
    "o/",
    "-o/r",
    undefined,
    null,
    5,
  ],
  number: BAD_NUMBERS,
  page: BAD_NUMBERS,
  sha: [
    "",
    "A".repeat(40),
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    "../../../x",
    `${"a".repeat(40)}/../x`,
    `${"a".repeat(40)}?x=1`,
    `${"a".repeat(40)}\n`,
    "main",
    undefined,
    null,
    5,
  ],
  login: [
    "",
    "-a",
    "a b",
    "a/b",
    "a?b=c",
    "a#b",
    "%2e%2e",
    "..",
    "a..b",
    "a.b",
    "a_b",
    "dependabot[bot]",
    "x".repeat(40),
    "ünï",
    "a\n",
    undefined,
    null,
    5,
  ],
};

Deno.test("issue 82 provider reads: invalid inputs are refused before any request so they cannot select another endpoint", async () => {
  for (const read of READS) {
    for (const field of read.fields) {
      for (const bad of BAD_INPUTS[field]) {
        const requests: Request[] = [];
        const client = clientFor(() => Response.json([]), requests);
        const label = `${read.name} ${field}=${String(bad)}`;
        await assertUnavailable(
          () => read.call(client, { ...GOOD_INPUT, [field]: bad }),
          label,
        );
        assertEquals(requests.length, 0, label);
      }
    }
  }
  // Inputs the reads do not use never matter: a bad login does not stop an issue read.
  const requests: Request[] = [];
  const client = clientFor(() => new Response(null, { status: 404 }), requests);
  assertEquals(
    await client.readIssueDetail(
      { ...GOOD_INPUT, login: "../x", sha: "nope" } as never,
      signal(),
    ),
    { kind: "gone" },
  );
  assertEquals(requests.length, 1);
});

Deno.test("issue 82 provider reads: logins of one to 39 letters, digits and inner or trailing hyphens are sent as given", async () => {
  const requests: Request[] = [];
  const client = clientFor(() => new Response(null, { status: 404 }), requests);
  const logins = [
    "a",
    "Z",
    "0",
    "octocat",
    "a-b",
    "a--b",
    "a-",
    "x".repeat(39),
  ];
  for (const login of logins) {
    assertEquals(
      await client.readCollaboratorPermission(
        { token: "t", fullName: "o/r", login },
        signal(),
      ),
      { kind: "gone" },
      login,
    );
  }
  assertEquals(
    requests.map((request) => new URL(request.url).pathname),
    logins.map((login) => `/repos/o/r/collaborators/${login}/permission`),
  );
});

Deno.test("issue 82 provider reads: numbers and pages that are positive safe integers are accepted at the edges", async () => {
  const requests: Request[] = [];
  const client = clientFor(() => Response.json([]), requests);
  await client.listBlockedBy(
    {
      token: "t",
      fullName: "o/r",
      number: Number.MAX_SAFE_INTEGER,
      page: Number.MAX_SAFE_INTEGER,
    },
    signal(),
  );
  await client.listIssueEvents({
    token: "t",
    fullName: "o/r",
    number: 1,
    page: 1,
  }, signal());
  assertEquals(requests.length, 2);
  assertEquals(
    new URL(requests[0].url).pathname,
    `/repos/o/r/issues/${Number.MAX_SAFE_INTEGER}/dependencies/blocked_by`,
  );
});

Deno.test("issue 82 provider reads: the fake needs a token minted for the repository and the permission each ticket read names, like GitHub", async () => {
  const f = await fixture();
  const { github, repository, other, fullName, otherFullName, mint } = f;
  github.seedIssues(repository.id, [{ number: 1 }]);
  github.seedCollaborator(repository.id, "octocat", {
    id: 5,
    permission: "write",
  });
  const asRead = (token: string) => {
    const { client } = github;
    const base = { token, fullName };
    return {
      detail: () => client.readIssueDetail({ ...base, number: 1 }, signal()),
      blockers: () =>
        client.listBlockedBy({ ...base, number: 1, page: 1 }, signal()),
      events: () =>
        client.listIssueEvents({ ...base, number: 1, page: 1 }, signal()),
      pulls: () =>
        client.listCommitPullRequests({ ...base, sha: SHA, page: 1 }, signal()),
      permission: () =>
        client.readCollaboratorPermission(
          { ...base, login: "octocat" },
          signal(),
        ),
    };
  };
  const forbidden = async (call: () => Promise<unknown>, label: string) => {
    const error = await assertRejects(
      call,
      GitHubReadFailure,
      undefined,
      label,
    );
    assertEquals(error.kind, "forbidden", label);
  };
  // The ticket token: everything reads.
  const ticket = asRead(f.token);
  assertEquals((await ticket.detail()).kind, "issue");
  await ticket.blockers();
  await ticket.events();
  await ticket.pulls();
  assertEquals((await ticket.permission()).kind, "present");
  // Metadata alone reads only the collaborator permission.
  const metadata = asRead(
    await mint([repository.id], { metadata: "read" }),
  );
  await forbidden(metadata.detail, "metadata detail");
  await forbidden(metadata.blockers, "metadata blockers");
  await forbidden(metadata.events, "metadata events");
  await forbidden(metadata.pulls, "metadata pulls");
  assertEquals((await metadata.permission()).kind, "present");
  // Issues read covers the issue routes; commit pull requests need pull requests read.
  const issues = asRead(
    await mint([repository.id], { metadata: "read", issues: "read" }),
  );
  assertEquals((await issues.detail()).kind, "issue");
  await issues.blockers();
  await issues.events();
  await forbidden(issues.pulls, "issues pulls");
  // Pull requests read alone reads an issue number and the commit pulls, not blockers or events.
  const pulls = asRead(
    await mint([repository.id], { metadata: "read", pull_requests: "read" }),
  );
  assertEquals((await pulls.detail()).kind, "issue");
  await pulls.pulls();
  await forbidden(pulls.blockers, "pulls blockers");
  await forbidden(pulls.events, "pulls events");
  // A write level covers a read.
  const writer = asRead(
    await mint([repository.id], {
      metadata: "read",
      issues: "write",
      pull_requests: "write",
    }),
  );
  await writer.blockers();
  await writer.pulls();
  // Another repository of the installation is hidden (404): gone, or a failure for a list.
  const hidden = await github.client.readIssueDetail(
    { token: f.token, fullName: otherFullName, number: 1 },
    signal(),
  );
  assertEquals(hidden, { kind: "gone" });
  assertEquals(
    await github.client.readCollaboratorPermission(
      { token: f.token, fullName: otherFullName, login: "octocat" },
      signal(),
    ),
    { kind: "gone" },
  );
  await assertUnavailable(
    () =>
      github.client.listBlockedBy({
        token: f.token,
        fullName: otherFullName,
        number: 1,
        page: 1,
      }, signal()),
    "blockers of a hidden repository",
  );
  assert(other.id !== repository.id);
  // A revoked or made-up token is a rejected credential.
  const revoked = await mint([repository.id]);
  github.revokedTokens.push(revoked);
  for (const read of Object.values(asRead(revoked))) {
    const error = await assertRejects(read, GitHubReadFailure);
    assertEquals(error.kind, "rejected");
  }
  const madeUp = asRead("ghs_madeup");
  const error = await assertRejects(madeUp.events, GitHubReadFailure);
  assertEquals(error.kind, "rejected");
});

Deno.test("issue 82 provider reads: every ticket read reports rate limits with a bounded wait and keeps other failures redacted", async () => {
  const f = await fixture(200);
  f.github.seedIssues(f.repository.id, [{ number: 1 }]);
  for (const [route, call] of liveReads(f)) {
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
        () => call(),
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
    const outage = await assertRejects(() => call(), StandardError);
    assertEquals(outage.code, "DEPENDENCY_UNAVAILABLE");
    assert(!surface(outage).includes(FAKE_PROVIDER_CANARY), route);
    assert(!surface(outage).includes(f.token), route);
    // The scripted failure was consumed: the next read answers.
    await call();
  }
});

Deno.test("issue 82 provider reads: failNext scripts one failure per matching ticket route and leaves the others alone", async () => {
  const f = await fixture();
  f.github.seedIssues(f.repository.id, [{ number: 1 }]);
  const reads = new Map(liveReads(f));
  f.github.failNext("issue-events", "server_error", 2);
  f.github.failNext("blocked-by", "forbidden");
  // Other routes, including the plain issue read the detail read shares, are unaffected.
  await reads.get("issue")!();
  await reads.get("commit-pulls")!();
  await reads.get("collaborator-permission")!();
  await assertUnavailable(() => reads.get("issue-events")!(), "first");
  const forbidden = await assertRejects(
    () => reads.get("blocked-by")!(),
    GitHubReadFailure,
  );
  assertEquals(forbidden.kind, "forbidden");
  await assertUnavailable(() => reads.get("issue-events")!(), "second");
  await reads.get("issue-events")!();
  await reads.get("blocked-by")!();
  // The plain issue read and the detail read share the issue route.
  f.github.failNext("issue", "server_error");
  await assertUnavailable(
    () =>
      f.github.client.readIssue(
        { token: f.token, fullName: f.fullName, number: 1 },
        signal(),
      ),
    "readIssue",
  );
  await reads.get("issue")!();
});

Deno.test("issue 82 provider reads: ticket reads on a deleted, transferred or missing issue answer like the issue path, and seeding an unknown issue throws", async () => {
  const { github, repository, fullName, token } = await fixture();
  github.seedIssues(repository.id, [{ number: 1 }, { number: 2 }, {
    number: 3,
  }]);
  github.deleteIssue(repository.id, 2);
  github.transferIssue(repository.id, 3);
  const raw = async (path: string) =>
    (await github.fetch(`https://api.github.com/repos/${fullName}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })).status;
  for (const suffix of ["/events", "/dependencies/blocked_by"]) {
    assertEquals(await raw(`/issues/1${suffix}`), 200, suffix);
    assertEquals(await raw(`/issues/2${suffix}`), 410, suffix);
    assertEquals(await raw(`/issues/3${suffix}`), 301, suffix);
    assertEquals(await raw(`/issues/99${suffix}`), 404, suffix);
    assertEquals(await raw(`/issues/x${suffix}`), 404, suffix);
  }
  assertEquals(await raw(`/commits/${SHA}/pulls`), 200);
  assertEquals(await raw(`/commits/not-a-sha/pulls`), 422);
  assertEquals(await raw(`/collaborators/nobody/permission`), 404);
  assertEquals(await raw(`/collaborators/nobody`), 404);
  assertEquals(await raw(`/issues/1/dependencies`), 404);
  assertThrows(
    () => github.seedIssueDetail(repository.id, 99, {}),
    Error,
    "unknown fake issue 99",
  );
  assertThrows(
    () => github.seedBlockedBy(repository.id, 99, []),
    Error,
    "unknown fake issue 99",
  );
  assertThrows(
    () => github.seedIssueEvent(repository.id, 99, { event: "closed" }),
    Error,
    "unknown fake issue 99",
  );
  // Listing under a deleted or transferred issue is a dependency failure for the client.
  for (const number of [2, 3, 99]) {
    await assertUnavailable(
      () =>
        github.client.listBlockedBy(
          { token, fullName, number, page: 1 },
          signal(),
        ),
      `blockers ${number}`,
    );
    await assertUnavailable(
      () =>
        github.client.listIssueEvents(
          { token, fullName, number, page: 1 },
          signal(),
        ),
      `events ${number}`,
    );
  }
});

Deno.test("issue 82 provider reads: the read token carries only the stated permissions and one repository id and never appears in the call log or a result", async () => {
  const f = await fixture();
  const { github, repository, fullName, token } = f;
  github.seedIssues(repository.id, [{
    number: 1,
    labels: ["ready for agent"],
  }]);
  github.seedBlockedBy(repository.id, 1, [{ number: 2 }]);
  github.seedIssueEvent(repository.id, 1, {
    event: "labeled",
    label: "ready for agent",
  });
  github.seedIssueEvent(repository.id, 1, { event: "closed", commitId: SHA });
  github.seedCommitPull(repository.id, SHA, {
    number: 5,
    mergedAt: "2026-10-30T09:30:00Z",
  });
  github.seedCollaborator(repository.id, "octocat", {
    id: 5,
    permission: "admin",
  });
  const base = { token, fullName };
  const results = [
    await github.client.readRepositoryIdentity({
      ...base,
      withDefaultBranch: true,
    }, signal()),
    await github.client.readIssueDetail({ ...base, number: 1 }, signal()),
    await github.client.listBlockedBy(
      { ...base, number: 1, page: 1 },
      signal(),
    ),
    await github.client.listIssueEvents(
      { ...base, number: 1, page: 1 },
      signal(),
    ),
    await github.client.listCommitPullRequests(
      { ...base, sha: SHA, page: 1 },
      signal(),
    ),
    await github.client.readCollaboratorPermission({
      ...base,
      login: "octocat",
    }, signal()),
  ];
  // The fixture minted one token, for one repository, with exactly the permissions it was given.
  assertEquals(github.tokenRequests.length, 1);
  assertEquals(github.tokenRequests[0].permissions, {
    metadata: "read",
    issues: "read",
    pull_requests: "read",
  });
  assertEquals(github.tokenRequests[0].repositoryIds, [repository.id]);
  assertEquals(github.issuedTokens, [token]);
  // Nothing the client returned carries the token, and the call log redacts it.
  assert(!JSON.stringify(results).includes(token));
  const ticketCalls = github.repositoryReadCalls();
  assertEquals(ticketCalls.length, results.length);
  for (const call of github.calls) {
    assert(!call.url.includes(token));
    for (const [name, value] of Object.entries(call.headers)) {
      assert(!value.includes(token), `${call.url} ${name}`);
    }
  }
  assert(
    ticketCalls.every((call) =>
      call.headers["authorization"] === "Bearer ghs_[redacted]"
    ),
  );
  // The reads never mint, revoke or list installation repositories.
  assertEquals(
    github.calls.filter((call) =>
      call.method !== "GET" && !call.url.includes("/access_tokens")
    ).length,
    0,
  );
});

Deno.test("issue 82 provider reads: failures and malformed answers of ticket reads never echo the token or the provider body", async () => {
  const token = "ghs_secret-token-value-77ab";
  const leaked = "provider-body-secret-value";
  const answers: [string, () => Response][] = [
    ["401", () => Response.json({ message: leaked }, { status: 401 })],
    ["403", () => Response.json({ message: leaked }, { status: 403 })],
    ["404", () => Response.json({ message: leaked }, { status: 404 })],
    [
      "429",
      () =>
        Response.json({ message: leaked }, {
          status: 429,
          headers: { "retry-after": "5", "x-token-echo": token },
        }),
    ],
    ["500", () => new Response(`${leaked} ${token}`, { status: 500 })],
    ["malformed", () => new Response(`{${token}`)],
    ["wrong shape", () => Response.json({ message: leaked, token })],
  ];
  for (const read of READS) {
    for (const [label, respond] of answers) {
      const outcome = await read.call(
        clientFor(() => respond()),
        { ...GOOD_INPUT, token },
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
        assert(
          !JSON.stringify(outcome.value).includes(leaked),
          `${read.name} ${label}`,
        );
      }
    }
  }
});

Deno.test("issue 82 provider reads: a caller that goes away is not a provider timeout for a ticket read", async () => {
  const { github, repository, fullName, token } = await fixture(5_000);
  github.seedIssues(repository.id, [{ number: 1 }]);
  github.failNext("issue-events", "hang");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const error = await assertRejects(
    () =>
      github.client.listIssueEvents(
        { token, fullName, number: 1, page: 1 },
        controller.signal,
      ),
    StandardError,
  );
  assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
});
