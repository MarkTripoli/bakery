/**
 * #445: the bakery command line against a real server. The tree is seeded
 * through the storage routes, a real access token is minted, and every
 * `bakery files` command runs through the generated client against the real
 * app and database: the evidence for the CLI half (each command and its exit
 * code is printed).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createFilesApi, run } from "@bakery/cli";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { mintToken } from "../helpers/access-tokens.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
} from "../helpers/worker-execution.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

/** A person's own request with the session cookie, to seed the tree. */
function asPerson(
  fixture: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: number } = {},
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
        ...(options.ifMatch === undefined
          ? {}
          : { "If-Match": '"' + options.ifMatch + '"' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  ));
}

async function seeded(response: Response, status = 200): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

const put = (
  fixture: Fixture,
  path: string,
  content: string,
  ifMatch?: number,
) =>
  asPerson(fixture, "PUT", "/v1/storage/files", {
    body: { path, mediaType: "text/plain", content: btoa(content) },
    ifMatch,
  });

Deno.test("every bakery files command works against a real server with a real access token", () =>
  withWorkerFixture(async (fixture) => {
    await seeded(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        body: { path: "/shared/docs" },
      }),
      201,
    );
    let plan = await seeded(
      await put(fixture, "/shared/plan.md", "first draft"),
    );
    plan = await seeded(
      await put(
        fixture,
        "/shared/plan.md",
        "second draft!",
        plan.version as number,
      ),
    );
    await seeded(await put(fixture, "/shared/docs/readme.md", "read me"));

    const token = await mintToken(
      fixture as unknown as Parameters<typeof mintToken>[0],
      undefined,
      ["bakery:read"],
      "cli-445 token",
    );
    const server = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.app.fetch(new Request(input, init));
      if (!response.ok && response.status !== 206) {
        console.log(
          "  server: " + response.status + " " +
            new URL(String(input)).pathname,
        );
      }
      return response;
    };

    const cli = async (argv: string[], secret = token.secret) => {
      const lines: string[] = [];
      const errors: string[] = [];
      const bytes: Uint8Array[] = [];
      const files: { path: string; content: Uint8Array }[] = [];
      const code = await run(argv, {
        environment: (name) =>
          ({
            BAKERY_URL: fixture.config.publicBaseUrl,
            BAKERY_ORGANIZATION: fixture.organizationId,
            BAKERY_TOKEN: secret,
          })[name],
        error: (line) => errors.push(line),
        createApi: (config) => createFilesApi(config, server as typeof fetch),
        output: {
          text: (line) => lines.push(line),
          bytes: (content) => bytes.push(content),
          file: (path, content) => {
            files.push({ path, content });
            return Promise.resolve();
          },
        },
      });
      console.log(
        "$ bakery " + argv.join(" ") + "  -> exit " + code +
          (errors.length > 0 ? "  | " + errors.join(" / ") : ""),
      );
      return {
        code,
        lines,
        errors,
        text: bytes.map((chunk) => new TextDecoder().decode(chunk)).join(""),
        files,
      };
    };

    const top = await cli(["files", "ls"]);
    assertEquals(top.code, 0);
    assert(top.lines.includes("shared/"), top.lines.join("|"));

    const shared = await cli(["files", "ls", "/shared"]);
    assertEquals(shared.code, 0);
    assert(
      shared.lines.includes("docs/") && shared.lines.includes("plan.md"),
      shared.lines.join("|"),
    );
    assert(
      shared.lines.indexOf("docs/") < shared.lines.indexOf("plan.md"),
      "folders first",
    );

    const long = await cli(["files", "ls", "-l", "/shared"]);
    assertEquals(long.code, 0);
    assert(
      long.lines.some((line) =>
        line.includes("plan.md") && line.includes("13 B")
      ),
      long.lines.join("|"),
    );

    const stat = await cli(["files", "stat", "/shared/plan.md"]);
    assertEquals(stat.code, 0);
    assert(
      stat.lines.some((line) => /^Path\s+\/shared\/plan\.md$/.test(line)),
      stat.lines.join("|"),
    );
    assert(stat.lines.some((line) => /^Type\s+text\/plain$/.test(line)));

    const history = await cli(["files", "history", "/shared/plan.md"]);
    assertEquals(history.code, 0);
    assertStringIncludes(history.lines[1], "current");
    assertEquals(history.lines.length, 3);
    const versions = JSON.parse(
      (await cli(["files", "history", "/shared/plan.md", "--json"])).lines.join(
        "\n",
      ),
    ) as {
      id: string;
      revision: number;
      isCurrent: boolean;
    }[];
    const first = versions.find((version) => version.revision === 1)!;
    const second = versions.find((version) => version.revision === 2)!;

    const openFirst = await cli(["files", "open", first.id]);
    assertEquals([openFirst.code, openFirst.lines], [0, ["/shared/plan.md@1"]]);
    const openSecond = await cli(["files", "open", "@" + second.id]);
    assertEquals([openSecond.code, openSecond.lines], [0, [
      "/shared/plan.md@2 (current)",
    ]]);
    const statVersion = await cli(["files", "stat", "@" + first.id]);
    assert(
      statVersion.lines.some((line) => /^Revision\s+1 \(older\)$/.test(line)),
      statVersion.lines.join("|"),
    );

    const current = await cli(["files", "cat", "/shared/plan.md"]);
    assertEquals([current.code, current.text], [0, "second draft!"]);
    const older = await cli(["files", "cat", "/shared/plan.md@1"]);
    assertEquals([older.code, older.text], [0, "first draft"]);
    const byVersion = await cli(["files", "cat", "@" + first.id]);
    assertEquals(byVersion.text, "first draft");
    const ranged = await cli([
      "files",
      "cat",
      "/shared/plan.md",
      "--range",
      "bytes=0-5",
    ]);
    assertEquals([ranged.code, ranged.text], [0, "second"]);

    const saved = await cli([
      "files",
      "get",
      "/shared/docs/readme.md",
      "-o",
      "out/readme.md",
    ]);
    assertEquals(saved.code, 0);
    assertEquals(saved.files.map((file) => file.path), ["out/readme.md"]);
    assertEquals(new TextDecoder().decode(saved.files[0].content), "read me");

    const uses = await cli(["files", "uses", "/shared/plan.md"]);
    assertEquals([uses.code, uses.lines], [0, [
      "Nothing has used this file yet.",
    ]]);

    // The server's search finds working-area files since #755, so a hit
    // comes back through the real route.
    const found = await cli(["files", "search", "plan"]);
    assertEquals([found.code, found.lines], [
      0,
      ["/shared/plan.md  file  13 B"],
    ]);
    const inFolder = await cli(["files", "search", "--in", "/shared"]);
    assertEquals(inFolder.code, 0);
    assert(
      // The CLI pads its columns to the longest path, so match any run of spaces.
      inFolder.lines.some((line) =>
        /^\/shared\/plan\.md\s+file\s+13 B$/.test(line)
      ),
      "a search in a folder lists its files: " + inFolder.lines.join(" | "),
    );

    const missing = await cli(["files", "ls", "/shared/nothing"]);
    assertEquals([missing.code, missing.errors], [1, [
      "No such file or folder: /shared/nothing",
    ]]);
    const noVersion = await cli(["files", "open", crypto.randomUUID()]);
    assertEquals(noVersion.code, 1);
    assertStringIncludes(noVersion.errors[0], "Not found");
    const badToken = await cli(["files", "ls"], "bky_not_a_real_token_value");
    assertEquals(badToken.code, 1);
    assertStringIncludes(badToken.errors[0], "Not signed in");
    assert(!JSON.stringify(badToken).includes("bky_not_a_real_token_value"));
  }));

Deno.test("an access token with the read scope reads the storage tree and nothing else", () =>
  withWorkerFixture(async (fixture) => {
    const plan = await seeded(
      await put(fixture, "/shared/plan.md", "first draft"),
    );
    const token = await mintToken(
      fixture as unknown as Parameters<typeof mintToken>[0],
      undefined,
      ["bakery:read"],
      "cli-445 read token",
    );
    const asToken = (method: string, path: string, body?: unknown) =>
      Promise.resolve(fixture.app.fetch(
        new Request(fixture.config.publicBaseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${token.secret}`,
            "Bakery-Organization-Id": fixture.organizationId,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...(method === "GET"
              ? {}
              : { "Idempotency-Key": crypto.randomUUID() }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ));
    const statusOf = async (response: Response) => {
      await response.body?.cancel();
      return response.status;
    };

    // Reads of the tree and file search are open to the token.
    assertEquals(
      await statusOf(await asToken("GET", "/v1/storage/roots")),
      200,
    );
    assertEquals(
      await statusOf(await asToken("GET", "/v1/files/search?query=plan")),
      200,
    );
    // A write on the same paths is not: the token is refused as the browser session middleware refuses one.
    assertEquals(
      await statusOf(
        await asToken("PUT", "/v1/storage/files", {
          path: "/shared/evil.md",
          mediaType: "text/plain",
          content: btoa("x"),
        }),
      ),
      401,
    );
    assertEquals(
      await statusOf(
        await asToken("POST", "/v1/storage/folders", { path: "/shared/evil" }),
      ),
      401,
    );
    // Other routes of the same router stay closed to a token, reads included:
    // the rest of the file routes, storage settings and the trash, and the
    // artifact and blob routes that share the router.
    const someId = crypto.randomUUID();
    for (
      const path of [
        "/v1/artifacts",
        "/v1/files/library",
        `/v1/artifact-versions/${someId}`,
        "/v1/artifact-storage",
        `/v1/blobs/${someId}`,
        "/v1/storage/settings",
        "/v1/storage/trash",
        "/v1/storage/agent-file-grants",
      ]
    ) {
      assertEquals(await statusOf(await asToken("GET", path)), 401, path);
    }
    // The allowlisted reads stay open: the command line's own routes.
    for (
      const path of [
        `/v1/storage/files/${plan.id}/uses`,
        `/v1/storage/files/${plan.id}/versions`,
      ]
    ) {
      assertEquals(await statusOf(await asToken("GET", path)), 200, path);
    }
    // Only a GET is open on those paths: a write of any method on each of them
    // is refused as the browser session middleware refuses one.
    for (
      const path of [
        "/v1/files/search",
        "/v1/storage/roots",
        `/v1/storage/folders/${someId}/entries`,
        `/v1/storage/files/${plan.id}/versions`,
        `/v1/storage/files/${plan.id}/uses`,
        `/v1/storage/files/${plan.id}/content`,
        `/v1/storage/file-versions/${someId}`,
      ]
    ) {
      for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
        assertEquals(
          await statusOf(await asToken(method, path, {})),
          401,
          method + " " + path,
        );
      }
    }
    // A token acts in one organization: in another one it reads nothing.
    const foreign = await createWorkerScope(fixture, "cli-445", fixture);
    try {
      const readIn = async (
        secret: string,
        organizationId: string,
        path: string,
      ) =>
        await fixture.app.fetch(
          new Request(fixture.config.publicBaseUrl + path, {
            headers: {
              Authorization: `Bearer ${secret}`,
              "Bakery-Organization-Id": organizationId,
            },
          }),
        );
      const mine = [
        "/v1/storage/roots",
        `/v1/storage/files/${plan.id}/versions`,
        `/v1/storage/files/${plan.id}/content`,
        "/v1/files/search?query=plan",
      ];
      // The token of my organization, asked in the other one: not found, nothing returned.
      for (const path of mine) {
        const response = await readIn(
          token.secret,
          foreign.organizationId,
          path,
        );
        assertEquals(await statusOf(response), 404, path);
      }
      // A token minted in the other organization.
      const minted = await seeded(
        await fixture.app.fetch(
          new Request(fixture.config.publicBaseUrl + "/v1/access-tokens", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": foreign.organizationId,
              Cookie: fixture.adminCookie,
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              name: "cli-445 foreign token",
              scopes: ["bakery:read"],
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          }),
        ),
        201,
      );
      const foreignSecret = minted.secret as string;
      // It reads its own organization (which holds no file called plan) ...
      const own = await readIn(
        foreignSecret,
        foreign.organizationId,
        "/v1/files/search?query=plan",
      );
      assertEquals(own.status, 200);
      assertEquals(((await own.json()) as Json).items, []);
      // ... and nothing of mine, whichever organization it names.
      for (
        const organizationId of [foreign.organizationId, fixture.organizationId]
      ) {
        for (const path of mine.slice(1, 3)) {
          const response = await readIn(foreignSecret, organizationId, path);
          assertEquals(
            await statusOf(response),
            404,
            organizationId + " " + path,
          );
        }
      }
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
    // Nothing was written.
    const roots = await seeded(
      await asPerson(fixture, "GET", "/v1/storage/roots"),
    );
    const shared = (roots.items as Json[]).find((item) =>
      item.path === "/shared"
    )!;
    const entries = await seeded(
      await asPerson(
        fixture,
        "GET",
        `/v1/storage/folders/${shared.id}/entries`,
      ),
    );
    assertEquals((entries.items as Json[]).map((item) => item.path), [
      "/shared/plan.md",
    ]);
    // A garbage token is no token.
    const nonsense = await fixture.app.fetch(
      new Request(fixture.config.publicBaseUrl + "/v1/storage/roots", {
        headers: {
          Authorization: "Bearer bky_nonsense",
          "Bakery-Organization-Id": fixture.organizationId,
        },
      }),
    );
    assertEquals(await statusOf(nonsense), 401);
  }));
