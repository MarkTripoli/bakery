/**
 * The CLI inside a session (#404).
 *
 * The point of these cases is the boundary the ticket is about: a session has
 * no access token, its credential lives in a file rather than an environment
 * variable, and every call is a gateway call of the same operation the person's
 * CLI would use. A bug here is not a cosmetic one - it is either a credential in
 * `ps` output or a command that quietly does something the scope never allowed.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import {
  createSessionApi,
  createSessionFilesApi,
  readSessionConfig,
  run,
  SESSION_ENVIRONMENT,
  type SessionConfig,
  SessionFileMismatch,
  SessionRefusal,
} from "@bakery/cli";

const ORG = "00000000-0000-4000-8000-000000000003";
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const HOST_TOKEN = "host_credential_value_0123456789";
const SESSION_TOKEN = "session_credential_value_abcdef";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function environmentOf(values: Record<string, string>) {
  return (name: string) => values[name];
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    baseUrl: "https://bakery.example.com",
    sessionToken: SESSION_TOKEN,
    ...overrides,
  };
}

type Seen = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}>;

/** A gateway stand-in: records what it was sent and answers from the case. */
function fakeGateway(
  answer: (seen: Seen) => Response | Promise<Response>,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body)
      : undefined;
    const record = { url, method: init?.method ?? "GET", headers, body };
    seen.push(record);
    return await answer(record);
  }) as typeof fetch;
  return { fetch: fetchImplementation, seen };
}

const TOOLS = [
  {
    name: "storageRoots.list",
    method: "GET",
    path: "/v1/storage/roots",
    scope: "files.read",
    readOnly: true,
  },
  {
    name: "storageFolderEntries.list",
    method: "GET",
    path: "/v1/storage/folders/:id/entries",
    scope: "files.read",
    readOnly: true,
  },
  {
    name: "storageFileVersions.list",
    method: "GET",
    path: "/v1/storage/files/:id/versions",
    scope: "files.read",
    readOnly: true,
  },
  {
    name: "storageFileUses.list",
    method: "GET",
    path: "/v1/storage/files/:id/uses",
    scope: "files.read",
    readOnly: true,
  },
  {
    name: "storageFiles.byVersion",
    method: "GET",
    path: "/v1/storage/file-versions/:id",
    scope: "files.read",
    readOnly: true,
  },
  {
    name: "storageFiles.content",
    method: "GET",
    path: "/v1/storage/files/:id/content",
    scope: "files.read",
    readOnly: true,
  },
  {
    name: "library.search",
    method: "GET",
    path: "/v1/library/search",
    scope: "library.read",
    readOnly: true,
  },
  {
    name: "storageFiles.pin",
    method: "PUT",
    path: "/v1/storage/files/:id/pin",
    scope: "files.write",
    readOnly: false,
  },
];

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * A gateway that answers the listing and the call as separate questions.
 *
 * The adapter asks what it may call before calling, so a fake that answers every
 * request with one body would test the refusal path instead of the call.
 */
function gatewayOf(
  answer: (seen: Seen) => Response,
  tools: readonly unknown[] = TOOLS,
): ReturnType<typeof fakeGateway> {
  return fakeGateway((seen) =>
    seen.url.endsWith("/session/tools")
      ? new Response(JSON.stringify({ tools }), { headers: JSON_HEADERS })
      : answer(seen)
  );
}

Deno.test("the credential comes from a file, never from an environment variable", async () => {
  // The contract's own words are why: a session credential "must never be copied
  // into job input, a log, an artifact or a subprocess environment". An
  // environment variable is a subprocess environment.
  const read: string[] = [];
  const config = await readSessionConfig({
    environment: environmentOf({
      [SESSION_ENVIRONMENT.url]: "https://bakery.example.com",
      [SESSION_ENVIRONMENT.credentialFile]: "/run/bakery/session-credential",
    }),
    flags: {},
    readFileText: (path) => {
      read.push(path);
      return Promise.resolve(`${SESSION_TOKEN}\n`);
    },
  });
  assertEquals(read, ["/run/bakery/session-credential"]);
  assertEquals(
    config.sessionToken,
    SESSION_TOKEN,
    "the file's newline was kept",
  );
  assertEquals(config.baseUrl, "https://bakery.example.com");
});

Deno.test("a session needs an address and one file, and nothing else", async () => {
  // Every real session failed at its first command because this asked for the
  // host token, the attempt id and the organization — none of which the worker
  // puts in an agent's environment, and none of which a session should hold.
  const config = await readSessionConfig({
    environment: environmentOf({
      [SESSION_ENVIRONMENT.url]: "https://bakery.example.com/",
      [SESSION_ENVIRONMENT.credentialFile]: "/run/bakery/session-credential",
      // Present in the worker's own environment and deliberately unused: if a
      // future change starts reading them, this case still passes only when the
      // credential file alone is enough.
      BAKERY_HOST_TOKEN: HOST_TOKEN,
      BAKERY_ATTEMPT_ID: ATTEMPT,
      BAKERY_ORGANIZATION: ORG,
    }),
    flags: {},
    readFileText: () => Promise.resolve(SESSION_TOKEN),
  });
  assertEquals(Object.keys(config).sort(), ["baseUrl", "sessionToken"]);
  assertEquals(
    config.baseUrl,
    "https://bakery.example.com",
    "a trailing slash was kept, so every path we append doubles it",
  );
});

Deno.test("a session with no credential file is refused, not guessed at", async () => {
  const missing = await assertRejectsUsage(() =>
    readSessionConfig({
      environment: environmentOf({
        [SESSION_ENVIRONMENT.url]: "https://bakery.example.com",
      }),
      flags: {},
      readFileText: () => Promise.resolve(""),
    })
  );
  assert(
    missing.includes(SESSION_ENVIRONMENT.credentialFile),
    `the refusal does not name the variable: ${missing}`,
  );
});

Deno.test("one credential travels, in the session header", async () => {
  // The host token identifies the machine and stays with the worker: an agent
  // that carried it could claim work and report a result as that machine. So a
  // session sends the session credential and no `authorization` at all.
  const gateway = fakeGateway(() =>
    new Response(JSON.stringify({ tools: TOOLS }), { headers: JSON_HEADERS })
  );
  await createSessionApi(config(), gateway.fetch).tools();
  assertEquals(gateway.seen.length, 1);
  const [seen] = gateway.seen;
  assertEquals(seen.headers.get("x-session-credential"), SESSION_TOKEN);
  assertEquals(
    seen.headers.get("authorization"),
    null,
    "a host token was sent",
  );
  assertEquals(seen.headers.get("cookie"), null, "a cookie was sent");
  assertEquals(seen.url, "https://bakery.example.com/v1/session/tools");
});

Deno.test("a call names the operation and carries the arguments unchanged", async () => {
  const gateway = gatewayOf(() =>
    new Response(
      JSON.stringify({
        outcome: "allowed",
        result: { items: [], nextCursor: null },
      }),
      { headers: JSON_HEADERS },
    )
  );
  const api = createSessionFilesApi(createSessionApi(config(), gateway.fetch));
  await api.entries(FILE_ID);
  const seen = gateway.seen.at(-1)!;
  assertEquals(seen.method, "POST");
  assertEquals(seen.url, "https://bakery.example.com/v1/session/call");
  assertEquals(seen.body, {
    tool: "storageFolderEntries.list",
    arguments: { id: FILE_ID },
  });
});

Deno.test("the server's refusal is repeated with the operation named", async () => {
  const gateway = gatewayOf(() =>
    new Response(
      JSON.stringify({
        code: "AUTH_FORBIDDEN",
        reason: "session_scope_denied",
      }),
      { status: 403, headers: JSON_HEADERS },
    )
  );
  const api = createSessionApi(config(), gateway.fetch);
  const error = await assertRejects(
    () => api.call("storageFiles.pin", { id: FILE_ID, pinned: true }),
  );
  assert(error instanceof SessionRefusal, "a refusal was not typed");
  assert(
    error.message.includes("storageFiles.pin"),
    "the operation is unnamed",
  );
  assert(
    error.advice.includes("storageFiles.pin"),
    "the advice names no grant",
  );
});

Deno.test("an audited denial is a failure, never an empty success", async () => {
  // The gateway answers a denied call with an outcome rather than a problem, so
  // a caller that only checked the status would print "done" for a refusal.
  const gateway = gatewayOf(() =>
    new Response(
      JSON.stringify({ outcome: "denied" }),
      { headers: JSON_HEADERS },
    )
  );
  const api = createSessionApi(config(), gateway.fetch);
  await assertRejects(
    () => api.call("storageFiles.pin", { id: FILE_ID, pinned: true }),
  );
});

Deno.test("a file's bytes come back decoded, and a wrong digest is refused", async () => {
  const text = "plan v2\n";
  const good = gatewayOf(() =>
    new Response(
      JSON.stringify({
        outcome: "allowed",
        result: {
          content: btoa(text),
          mediaType: "text/markdown",
          sha256: sha(text),
        },
      }),
      { headers: JSON_HEADERS },
    )
  );
  const api = createSessionFilesApi(createSessionApi(config(), good.fetch));
  const read = await api.content(FILE_ID, {});
  assertEquals(new TextDecoder().decode(read.content), text);
  assertEquals(read.contentType, "text/markdown");

  // The same bytes with a digest that is not theirs: `cat` would pipe them and
  // `get` would write them, so the read must fail instead of returning them.
  const bad = gatewayOf(() =>
    new Response(
      JSON.stringify({
        outcome: "allowed",
        result: { content: btoa("tampered\n"), sha256: sha(text) },
      }),
      { headers: JSON_HEADERS },
    )
  );
  const tampered = createSessionFilesApi(createSessionApi(config(), bad.fetch));
  const error = await assertRejects(() => tampered.content(FILE_ID, {}));
  assert(error instanceof SessionFileMismatch, "a mismatch was not named");
});

Deno.test("a command whose operation was not granted is refused before the call", async () => {
  // A credential with `files.read` but not `library.read`: the search is refused
  // here, and the refusal names the operation rather than the command, because
  // the grant is held by operation.
  const gateway = fakeGateway(() =>
    new Response(
      JSON.stringify({
        tools: TOOLS.filter((tool) => tool.name !== "library.search"),
      }),
      { headers: JSON_HEADERS },
    )
  );
  const api = createSessionFilesApi(createSessionApi(config(), gateway.fetch));
  const message = await assertRejectsUsage(() => api.search({ query: "plan" }));
  assert(message.includes("library.search"), `unnamed: ${message}`);
  // One listing and no second request: a refusal must not look like an attempt.
  assertEquals(gateway.seen.length, 1);
});

Deno.test("a pin is refused with the reason a person can act on", async () => {
  const gateway = gatewayOf(() =>
    new Response(JSON.stringify({ outcome: "allowed" }), {
      headers: JSON_HEADERS,
    })
  );
  const api = createSessionFilesApi(createSessionApi(config(), gateway.fetch));
  const message = await assertRejectsUsage(() => api.pin(FILE_ID, true));
  assert(message.includes("administrator"), `unclear: ${message}`);
  // No call was made: a session telling an agent "denied" would read as a bug.
  assertEquals(
    gateway.seen.filter((seen) => seen.url.endsWith("/session/call")).length,
    0,
  );
});

Deno.test("a search the session cannot filter is refused, not widened", async () => {
  const gateway = fakeGateway(() =>
    new Response(JSON.stringify({ tools: TOOLS }), { headers: JSON_HEADERS })
  );
  const api = createSessionFilesApi(createSessionApi(config(), gateway.fetch));
  const message = await assertRejectsUsage(() =>
    api.search({ query: "plan", path: "/projects" })
  );
  assert(message.includes("path"), `the refusal names no filter: ${message}`);
});

Deno.test("bakery tools lists what the session may call, and nothing else", async () => {
  const gateway = fakeGateway(() =>
    new Response(JSON.stringify({ tools: TOOLS }), { headers: JSON_HEADERS })
  );
  const lines: string[] = [];
  const code = await run(["tools"], {
    environment: environmentOf({
      [SESSION_ENVIRONMENT.url]: "https://bakery.example.com",
      [SESSION_ENVIRONMENT.credentialFile]: "/run/bakery/session-credential",
    }),
    output: {
      text: (line) => lines.push(line),
      bytes: () => {},
      file: () => Promise.resolve(),
    },
    error: (line) => lines.push(`!${line}`),
    readFileText: () => Promise.resolve(SESSION_TOKEN),
    inSession: true,
    createSessionApi: () =>
      Promise.resolve(
        createSessionFilesApi(createSessionApi(config(), gateway.fetch)),
      ),
    listSessionTools: async () =>
      await createSessionApi(config(), gateway.fetch).tools(),
  });
  assertEquals(code, 0, lines.join("\n"));
  assertEquals(lines.length, TOOLS.length);
  assert(lines[0].startsWith("storageRoots.list"), lines[0]);
  assert(lines[0].includes("files.read"), "the scope is not shown");
});

async function assertRejects(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("the call resolved");
}

async function assertRejectsUsage(
  run: () => Promise<unknown>,
): Promise<string> {
  const error = await assertRejects(run);
  assert(
    error instanceof Error && error.name === "UsageError",
    `not a usage refusal: ${String(error)}`,
  );
  return (error as Error).message;
}

// The unused import is deliberate: `assertThrows` documents that the helpers
// above exist because every case here is async.
void assertThrows;
