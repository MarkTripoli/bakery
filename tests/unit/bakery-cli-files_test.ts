import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import {
  createFilesApi,
  normalizePath,
  parseRef,
  run,
  type Runtime,
} from "@bakery/cli";
import { madeBy } from "../../packages/cli/src/files.ts";

const ORG = "00000000-0000-4000-8000-000000000003";
const TOKEN = "bky_secret_token_value";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const PROJECTS = id(10);
const SHARED = id(11);
const WEB = id(12);
const DOCS = id(13);
const PLAN = id(20);
const NOTES = id(21);
const PLAN_V1 = id(31);
const PLAN_V2 = id(32);
const USER_HOME = id(14);
const HOME_NOTE = id(22);

const item = (
  n: string,
  path: string,
  kind: "folder" | "file",
  extra: Record<string, unknown> = {},
) => ({
  id: n,
  parentId: null,
  path,
  name: path.split("/").pop(),
  displayName: null,
  kind,
  policy: "record",
  kindName: null,
  mediaType: kind === "file" ? "text/markdown" : null,
  sizeBytes: kind === "file" ? 8 : null,
  artifactId: null,
  pinned: false,
  contentRemoved: false,
  updatedAt: "2026-11-02T10:00:00.000Z",
  ...extra,
});

const BODIES: Record<string, string> = { "1": "plan v1\n", "2": "plan v2\n" };

type Seen = { method: string; path: string; search: string; headers: Headers };

/** A tiny server for the storage reads, with two-page folders, so paging is exercised. */
function fakeServer(options: { digest?: string; problem?: number } = {}) {
  const seen: Seen[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const problem = (status: number, code: string) =>
    new Response(
      JSON.stringify({
        type: "https://bakery.example/problems/test",
        title: code,
        detail: code,
        status,
        code,
        retryable: false,
        requestId: id(900),
        traceId: id(901),
      }),
      { status, headers: { "content-type": "application/problem+json" } },
    );
  const fetchImplementation =
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        headers,
      });
      const path = url.pathname;
      if (options.problem !== undefined) {
        return Promise.resolve(problem(options.problem, "TEST"));
      }
      const cursor = url.searchParams.get("cursor");
      if (path === "/v1/storage/roots") {
        return Promise.resolve(json({
          items: [
            item(PROJECTS, "/projects", "folder"),
            item(SHARED, "/shared", "folder"),
            item(USER_HOME, `/users/${id(40)}`, "folder", {
              policy: "personal",
            }),
          ],
          nextCursor: null,
        }));
      }
      if (path === `/v1/storage/folders/${PROJECTS}/entries`) {
        return Promise.resolve(
          cursor === null
            ? json({
              items: [item(WEB, "/projects/web", "folder")],
              nextCursor: "page-2",
            })
            : json({
              items: [item(DOCS, "/projects/docs", "folder")],
              nextCursor: null,
            }),
        );
      }
      if (path === `/v1/storage/files/${PLAN}/pin` && init?.method === "PUT") {
        const { pinned } = JSON.parse(String(init.body)) as { pinned: boolean };
        return Promise.resolve(json({
          id: id(77),
          pinned,
          pinnedAt: pinned ? "2026-11-20T10:00:00.000Z" : null,
          pinnedBy: pinned ? id(40) : null,
          version: 5,
          unpinEligible: !pinned,
        }));
      }
      if (path === `/v1/storage/folders/${USER_HOME}/entries`) {
        return Promise.resolve(json({
          items: [item(HOME_NOTE, `/users/${id(40)}/todo.md`, "file")],
          nextCursor: null,
        }));
      }
      if (path === `/v1/storage/folders/${WEB}/entries`) {
        return Promise.resolve(json({
          items: [
            item(PLAN, "/projects/web/plan.md", "file", {
              sizeBytes: 8,
              artifactId: id(77),
            }),
            item(NOTES, "/projects/web/notes.bin", "file", {
              mediaType: "application/octet-stream",
              sizeBytes: 2048,
            }),
          ],
          nextCursor: null,
        }));
      }
      if (path === `/v1/storage/files/${PLAN}/versions`) {
        const version = (
          vid: string,
          revision: number,
          isCurrent: boolean,
        ) => ({
          id: vid,
          revision,
          isCurrent,
          createdAt: `2026-11-0${revision}T09:30:00.000Z`,
          sizeBytes: 8,
          mediaType: "text/markdown",
          sha256: sha(BODIES[String(revision)]),
          contentRemoved: false,
          removedAt: null,
          makerKind: "person",
          makerPrincipalId: id(40),
          makerName: "Ada",
          stepId: null,
          stepName: null,
          runId: null,
          workItemId: null,
          workItemTitle: null,
          sessionId: null,
          agentName: null,
          attemptId: null,
          actingForPrincipalId: null,
          actingForName: null,
        });
        return Promise.resolve(json({
          items: [version(PLAN_V1, 1, false), version(PLAN_V2, 2, true)],
          nextCursor: null,
        }));
      }
      if (path === `/v1/storage/files/${PLAN}/uses`) {
        return Promise.resolve(json({
          items: [{
            id: id(50),
            workItemId: id(51),
            workItemTitle: "Ship the web page",
            runId: id(52),
            inputName: "plan",
            versionId: PLAN_V1,
            revision: 1,
            usedAt: "2026-11-03T12:00:00.000Z",
          }],
          nextCursor: null,
        }));
      }
      const byVersion = /^\/v1\/storage\/file-versions\/(.+)$/.exec(path);
      if (byVersion !== null) {
        if (byVersion[1] === PLAN_V1 || byVersion[1] === PLAN_V2) {
          const current = byVersion[1] === PLAN_V2;
          return Promise.resolve(json({
            file: item(PLAN, "/projects/web/plan.md", "file"),
            versionId: byVersion[1],
            revision: current ? 2 : 1,
            isCurrent: current,
          }));
        }
        return Promise.resolve(problem(404, "RESOURCE_NOT_FOUND"));
      }
      if (path === `/v1/storage/files/${PLAN}/content`) {
        const revision = url.searchParams.get("revision") ?? "2";
        const body = BODIES[revision];
        if (body === undefined) {
          return Promise.resolve(problem(404, "RESOURCE_NOT_FOUND"));
        }
        const range = headers.get("range");
        const bytes = new TextEncoder().encode(body);
        const base = {
          "content-type": "text/markdown",
          etag: `"${options.digest ?? sha(body)}"`,
        };
        if (range === "bytes=0-3") {
          return Promise.resolve(
            new Response(bytes.slice(0, 4), {
              status: 206,
              headers: {
                ...base,
                "content-length": "4",
                "content-range": `bytes 0-3/${bytes.length}`,
              },
            }),
          );
        }
        if (range !== null) {
          return Promise.resolve(
            new Response(new Uint8Array(), {
              status: 416,
              headers: {
                ...base,
                "content-length": "0",
                "content-range": `bytes */${bytes.length}`,
              },
            }),
          );
        }
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { ...base, "content-length": String(bytes.length) },
          }),
        );
      }
      if (path === "/v1/files/search") {
        return Promise.resolve(json({
          items: [{
            source: "files",
            entryId: PLAN,
            itemId: null,
            path: "/projects/web/plan.md",
            name: "plan.md",
            kind: "document",
            mediaType: "text/markdown",
            mediaGroup: "text",
            sizeBytes: 8,
            versionId: PLAN_V2,
            producerId: null,
            producerKind: null,
            producerStepId: null,
            producerRunId: null,
            producerAttemptId: null,
            producerSessionId: null,
            producerAgentName: null,
            producerActingForId: null,
            producerActingForName: null,
            producerName: null,
            producerTaskId: null,
            producerTaskTitle: null,
            nameMatchStart: 0,
            nameMatchLength: 4,
            createdAt: "2026-11-02T10:00:00.000Z",
          }],
          nextCursor: null,
        }));
      }
      return Promise.resolve(problem(404, "RESOURCE_NOT_FOUND"));
    }) as typeof fetch;
  return { fetch: fetchImplementation, seen };
}

const ENV: Record<string, string> = {
  BAKERY_URL: "https://bakery.test",
  BAKERY_TOKEN: TOKEN,
  BAKERY_ORGANIZATION: ORG,
};

async function bakery(
  argv: string[],
  server = fakeServer(),
  environment: Record<string, string | undefined> = ENV,
  existing = false,
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const bytes: Uint8Array[] = [];
  const files: { path: string; content: Uint8Array; overwrite: boolean }[] = [];
  const runtime: Runtime = {
    environment: (name) => environment[name],
    error: (line) => errors.push(line),
    createApi: (config) => createFilesApi(config, server.fetch),
    output: {
      text: (line) => lines.push(line),
      bytes: (content) => bytes.push(content),
      file: (path, content, overwrite) => {
        if (existing && !overwrite) {
          return Promise.reject(
            Object.assign(new Error("exists"), { code: "EEXIST" }),
          );
        }
        files.push({ path, content, overwrite });
        return Promise.resolve();
      },
    },
  };
  const code = await run(argv, runtime);
  return {
    code,
    lines,
    errors,
    bytes: bytes.map((chunk) => new TextDecoder().decode(chunk)).join(""),
    files,
    seen: server.seen,
  };
}

Deno.test("ls at the top lists the top-level folders and sends the token and organization", async () => {
  const result = await bakery(["files", "ls"]);
  assertEquals(result.code, 0);
  assertEquals(result.lines, ["projects/", "shared/", `users/${id(40)}/`]);
  const [request] = result.seen;
  assertEquals(request.headers.get("authorization"), `Bearer ${TOKEN}`);
  assertEquals(request.headers.get("bakery-organization-id"), ORG);
});

Deno.test("ls reads a folder to its last page", async () => {
  const result = await bakery(["files", "ls", "/projects"]);
  assertEquals(result.lines, ["web/", "docs/"]);
  const pages = result.seen.filter((r) =>
    r.path.endsWith(`${PROJECTS}/entries`)
  );
  assertEquals(pages.length, 2);
  assertStringIncludes(pages[1].search, "cursor=page-2");
});

Deno.test("a path is found whatever its case and slashes; --long shows kind, size and name", async () => {
  const result = await bakery(["files", "ls", "-l", "//Projects/WEB/"]);
  assertEquals(result.code, 0);
  assertEquals(result.lines.length, 2);
  assertStringIncludes(result.lines[0], "file");
  assertStringIncludes(result.lines[0], "8 B");
  assertStringIncludes(result.lines[0], "plan.md");
  assertStringIncludes(result.lines[1], "2.0 KiB");
});

Deno.test("a top-level folder of two segments is walked into, and the folder listed names its entries by their own name", async () => {
  const home = await bakery(["files", "ls", `/users/${id(40)}`]);
  assertEquals(home.code, 0);
  assertEquals(home.lines, ["todo.md"]);
  const stat = await bakery(["files", "stat", `/users/${id(40)}/todo.md`]);
  assertEquals(stat.code, 0);
  assert(stat.lines.some((line) => /^Path\s+\/users\//.test(line)));
});

Deno.test("ls of a path that is not there says so and exits 1", async () => {
  const result = await bakery(["files", "ls", "/projects/nothing"]);
  assertEquals(result.code, 1);
  assertEquals(result.errors, ["No such file or folder: /projects/nothing"]);
});

Deno.test("stat names a file, and a version id names its file, revision and whether it is current", async () => {
  const byPath = await bakery(["files", "stat", "/projects/web/plan.md"]);
  assertEquals(byPath.code, 0);
  assert(
    byPath.lines.some((line) =>
      /^Path\s+\/projects\/web\/plan\.md$/.test(line)
    ),
  );
  assert(byPath.lines.some((line) => /^Type\s+text\/markdown$/.test(line)));
  const older = await bakery(["files", "stat", `@${PLAN_V1}`]);
  assert(older.lines.some((line) => /^Revision\s+1 \(older\)$/.test(line)));
  const json = await bakery(["files", "stat", `@${PLAN_V2}`, "--json"]);
  const parsed = JSON.parse(json.lines.join("\n"));
  assertEquals([parsed.path, parsed.revision, parsed.isCurrent], [
    "/projects/web/plan.md",
    2,
    true,
  ]);
});

Deno.test("history lists versions newest first and marks the current one", async () => {
  const result = await bakery(["files", "history", "/projects/web/plan.md"]);
  assertEquals(result.code, 0);
  assertStringIncludes(result.lines[0], "REV");
  assertStringIncludes(result.lines[1], "2");
  assertStringIncludes(result.lines[1], "current");
  assertStringIncludes(result.lines[2], "Ada");
  assertStringIncludes(result.lines[2], sha(BODIES["1"]).slice(0, 12));
});

Deno.test("history of a folder is refused", async () => {
  const result = await bakery(["files", "history", "/projects/web"]);
  assertEquals(result.code, 1);
  assertEquals(result.errors, ["/projects/web is a folder, not a file."]);
});

Deno.test("uses lists the runs that pinned a version", async () => {
  const result = await bakery(["files", "uses", "/projects/web/plan.md"]);
  assertStringIncludes(result.lines[1], "Ship the web page");
  assertStringIncludes(result.lines[1], "plan");
});

Deno.test("cat writes the current bytes, a named revision, or one byte range", async () => {
  assertEquals(
    (await bakery(["files", "cat", "/projects/web/plan.md"])).bytes,
    "plan v2\n",
  );
  const older = await bakery(["files", "cat", "/projects/web/plan.md@1"]);
  assertEquals(older.bytes, "plan v1\n");
  assertStringIncludes(older.seen.at(-1)!.search, "revision=1");
  assertEquals(
    (await bakery(["files", "cat", `@${PLAN_V1}`])).bytes,
    "plan v1\n",
  );
  const ranged = await bakery([
    "files",
    "cat",
    "/projects/web/plan.md",
    "--range",
    "bytes=0-3",
  ]);
  assertEquals(ranged.bytes, "plan");
  assertEquals(ranged.seen.at(-1)!.headers.get("range"), "bytes=0-3");
  const outside = await bakery([
    "files",
    "cat",
    "/projects/web/plan.md",
    "--range",
    "bytes=100-200",
  ]);
  assertEquals(outside.code, 1);
  assertEquals(outside.errors, [
    "That byte range is outside the file (it has 8 bytes).",
  ]);
});

Deno.test("get saves the file under its name or -o, checks the digest, and will not replace without --force", async () => {
  const saved = await bakery([
    "files",
    "get",
    "/projects/web/plan.md",
    "-o",
    "out/plan.md",
  ]);
  assertEquals(saved.code, 0);
  assertEquals(saved.files.map((f) => f.path), ["out/plan.md"]);
  assertEquals(new TextDecoder().decode(saved.files[0].content), "plan v2\n");
  assertEquals(saved.lines, ["Saved out/plan.md (8 B)"]);
  assertEquals(
    (await bakery(["files", "get", "/projects/web/plan.md"])).files[0].path,
    "plan.md",
  );

  // A file that already exists is refused until --force.
  const clash = await bakery(
    ["files", "get", "/projects/web/plan.md"],
    fakeServer(),
    ENV,
    true,
  );
  assertEquals(clash.code, 1);
  assertEquals(clash.errors, [
    "plan.md already exists; use --force to replace it.",
  ]);
  const forced = await bakery(
    ["files", "get", "/projects/web/plan.md", "--force"],
    fakeServer(),
    ENV,
    true,
  );
  assertEquals(forced.code, 0);
  assertEquals(forced.files.map((f) => f.overwrite), [true]);

  const bad = await bakery(
    ["files", "get", "/projects/web/plan.md"],
    fakeServer({ digest: "0".repeat(64) }),
  );
  assertEquals(bad.code, 1);
  assertEquals(bad.files, []);
  assertEquals(bad.errors, [
    "The downloaded bytes do not match the server's digest; nothing was saved.",
  ]);
});

Deno.test("open turns a version id into the path and revision it belongs to", async () => {
  assertEquals((await bakery(["files", "open", PLAN_V1])).lines, [
    "/projects/web/plan.md@1",
  ]);
  assertEquals((await bakery(["files", "open", `@${PLAN_V2}`])).lines, [
    "/projects/web/plan.md@2 (current)",
  ]);
  const gone = await bakery(["files", "open", id(99)]);
  assertEquals(gone.code, 1);
  assertEquals(gone.errors, [
    "Not found. It may have been removed, or you may not have access to it.",
  ]);
});

Deno.test("search sends the filters and lists the hits; it needs something to look for", async () => {
  const result = await bakery([
    "files",
    "search",
    "plan",
    "--in",
    "/projects",
    "--type",
    "text/markdown",
  ]);
  assertEquals(result.code, 0);
  assertStringIncludes(result.lines[0], "/projects/web/plan.md");
  const search = result.seen.at(-1)!.search;
  assertStringIncludes(search, "query=plan");
  assertStringIncludes(search, "path=%2Fprojects");
  assertStringIncludes(search, "mediaType=text%2Fmarkdown");
  const none = await bakery(["files", "search"]);
  assertEquals(none.code, 2);
});

Deno.test("a refusal is said in words, and the token is never printed", async () => {
  const cases: [number, string][] = [
    [
      401,
      "Not signed in: the access token is missing, expired or revoked. Make a new one in Settings.",
    ],
    [403, "You do not have access to that."],
    [
      404,
      "Not found. It may have been removed, or you may not have access to it.",
    ],
  ];
  for (const [status, message] of cases) {
    const result = await bakery(
      ["files", "ls"],
      fakeServer({ problem: status }),
    );
    assertEquals(result.code, 1);
    assertEquals(result.errors, [message]);
    assert(!JSON.stringify(result).includes(TOKEN));
  }
});

Deno.test("a missing setting is named, a --token flag is refused, and an unknown command exits 2", async () => {
  const noUrl = await bakery(["files", "ls"], fakeServer(), {
    ...ENV,
    BAKERY_URL: undefined,
  });
  assertEquals(noUrl.code, 2);
  assertStringIncludes(noUrl.errors[0], "BAKERY_URL");
  const noToken = await bakery(["files", "ls"], fakeServer(), {
    ...ENV,
    BAKERY_TOKEN: undefined,
  });
  assertStringIncludes(noToken.errors[0], "BAKERY_TOKEN");
  const flag = await bakery(["files", "ls", "--token", "x"]);
  assertEquals(flag.code, 2);
  assertStringIncludes(flag.errors[0], "no --token flag");
  assertEquals((await bakery(["files", "rm", "/x"])).code, 2);
  assertEquals((await bakery(["files"])).code, 2);
  assertEquals((await bakery(["--help"])).code, 0);
  assertEquals((await bakery(["ls"])).code, 2);
});

Deno.test("the token can come from a file", async () => {
  const lines: string[] = [];
  const server = fakeServer();
  const code = await run(["files", "ls"], {
    environment: (name) =>
      ({ ...ENV, BAKERY_TOKEN: undefined, BAKERY_TOKEN_FILE: "/run/token" })[
        name
      ],
    readFileText: () => Promise.resolve(`${TOKEN}\n`),
    error: () => {},
    createApi: (config) => createFilesApi(config, server.fetch),
    output: {
      text: (line) => lines.push(line),
      bytes: () => {},
      file: () => Promise.resolve(),
    },
  });
  assertEquals(code, 0);
  assertEquals(server.seen[0].headers.get("authorization"), `Bearer ${TOKEN}`);
});

Deno.test("references: a path, a path at a revision, or a version id", () => {
  assertEquals(parseRef("/a/b.md"), {
    kind: "path",
    path: "/a/b.md",
    revision: null,
  });
  assertEquals(parseRef("a//b.md@12"), {
    kind: "path",
    path: "/a/b.md",
    revision: 12,
  });
  assertEquals(parseRef(`@${PLAN_V1}`), {
    kind: "version",
    versionId: PLAN_V1,
  });
  assertEquals(normalizePath(""), "/");
  assertEquals(normalizePath("/x/y/"), "/x/y");
});

Deno.test("versions: an agent's version names the agent and the person, never the person alone", () => {
  const base = { makerName: "Ada", agentName: "Reviewer" };
  assertEquals(
    madeBy({ ...base, makerKind: "agent" } as Parameters<typeof madeBy>[0]),
    "agent Reviewer for Ada",
  );
  assertEquals(
    madeBy(
      { ...base, makerKind: "agent", agentName: null } as Parameters<
        typeof madeBy
      >[0],
    ),
    "an agent for Ada",
  );
  assertEquals(
    madeBy({ ...base, makerKind: "person" } as Parameters<typeof madeBy>[0]),
    "Ada",
  );
});

Deno.test("stat shows whether a file is pinned", async () => {
  const result = await bakery(["files", "stat", "/projects/web/plan.md"]);
  assert(result.lines.some((line) => /^Pinned\s+no$/.test(line)));
});

Deno.test("pin and unpin set the pin on the file by its id, with the token, and say what happened", async () => {
  const pinned = await bakery(["files", "pin", "/projects/web/plan.md"]);
  assertEquals(pinned.code, 0);
  assertEquals(pinned.lines, ["Pinned /projects/web/plan.md"]);
  const call = pinned.seen.find((entry) => entry.method === "PUT")!;
  assertEquals(call.path, `/v1/storage/files/${PLAN}/pin`);
  assertEquals(call.headers.get("authorization"), `Bearer ${TOKEN}`);
  assertEquals(call.headers.get("bakery-organization-id"), ORG);
  assert(
    (call.headers.get("idempotency-key") ?? "") !== "",
    "a pin is a command: it carries an Idempotency-Key",
  );
  const unpinned = await bakery(["files", "unpin", "/projects/web/plan.md"]);
  assertEquals(unpinned.code, 0);
  assertEquals(unpinned.lines, [
    "Unpinned /projects/web/plan.md (an expired version may now be collected)",
  ]);
  const json = await bakery([
    "files",
    "pin",
    "/projects/web/plan.md",
    "--json",
  ]);
  assertEquals(JSON.parse(json.lines.join("\n")).pinned, true);
});

Deno.test("pin refuses a working-area file, a folder and a revision before asking the server", async () => {
  const working = await bakery(["files", "pin", "/projects/web/notes.bin"]);
  assertEquals(working.code, 1);
  assert(/working-area file/.test(working.errors.join(" ")));
  assert(working.seen.every((entry) => entry.method !== "PUT"));
  const folder = await bakery(["files", "pin", "/projects/web"]);
  assertEquals(folder.code, 1);
  const revision = await bakery(["files", "pin", "/projects/web/plan.md@1"]);
  assertEquals(revision.code, 1);
  assert(/not on one revision/.test(revision.errors.join(" ")));
  assert(revision.seen.every((entry) => entry.method !== "PUT"));
});

Deno.test("a refused pin says why in words", async () => {
  const forbidden = await bakery(
    ["files", "pin", "/projects/web/plan.md"],
    fakeServer({ problem: 403 }),
  );
  assertEquals(forbidden.code, 1);
  assert(/access/.test(forbidden.errors.join(" ")));
});
