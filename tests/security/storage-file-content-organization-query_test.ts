/**
 * #445 slice D [AUTH]: GET /v1/storage/files/:id/content accepts the
 * organization as `?organizationId=` so a <video>/<audio> src can play a file
 * with the session cookie alone, Range requests included. The query goes
 * through the same parsing and membership check as the
 * Bakery-Organization-Id header, the header wins, a header and query that
 * differ are refused, and no other action reads the query.
 */

import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
} from "../helpers/worker-execution.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

/** A cookie-only GET, as a media element sends it: no organization header. */
function media(
  fixture: Fixture,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method: "GET",
      headers: { Cookie: fixture.adminCookie, ...headers },
    }),
  ));
}

async function putFile(
  fixture: Fixture,
  organizationId: string,
  path: string,
  content: string,
): Promise<string> {
  const response = await fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + "/v1/storage/files", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        path,
        mediaType: "text/plain",
        content: btoa(content),
      }),
    }),
  );
  const text = await response.text();
  assertEquals(response.status, 200, text);
  return (JSON.parse(text) as Json).id as string;
}

async function status(response: Response, expected: number): Promise<string> {
  const text = await response.text();
  assertEquals(response.status, expected, text);
  return text;
}

/** A refusal: a problem body naming the code, never the file's bytes. */
async function refused(response: Response, code: string) {
  const text = await response.text();
  assert(
    response.status === 403 || response.status === 404,
    response.status + " " + text,
  );
  assertEquals((JSON.parse(text) as Json).code, code, text);
}

const own = (fixture: Fixture) =>
  "/users/" + fixture.principalId + "/uploads/clip.txt";

Deno.test("a cookie and ?organizationId= read my file whole, by range, and 416 past the end", () =>
  withWorkerFixture(async (fixture) => {
    const id = await putFile(
      fixture,
      fixture.organizationId,
      own(fixture),
      "hello, media",
    );
    const content = "/v1/storage/files/" + id + "/content?organizationId=" +
      fixture.organizationId;

    assertEquals(
      await status(await media(fixture, content), 200),
      "hello, media",
    );
    const ranged = await media(fixture, content, { Range: "bytes=7-11" });
    assertEquals(await status(ranged, 206), "media");
    assertEquals(ranged.headers.get("Content-Range"), "bytes 7-11/12");
    await status(await media(fixture, content, { Range: "bytes=99-" }), 416);
    // The query value is parsed like the header: case does not matter.
    await status(
      await media(
        fixture,
        "/v1/storage/files/" + id + "/content?organizationId=" +
          fixture.organizationId.toUpperCase(),
      ),
      200,
    );
    // Neither header nor query is still SCOPE_REQUIRED; a malformed query is
    // refused like a malformed header.
    const none = await media(fixture, "/v1/storage/files/" + id + "/content");
    assertEquals(
      (JSON.parse(await none.text()) as Json).code,
      "SCOPE_REQUIRED",
    );
    const bad = await media(
      fixture,
      "/v1/storage/files/" + id + "/content?organizationId=not-a-uuid",
    );
    assertEquals(
      (JSON.parse(await bad.text()) as Json).code,
      "MALFORMED_REQUEST",
    );
  }));

Deno.test("the query organization is membership-checked and must agree with the header", () =>
  withWorkerFixture(async (fixture) => {
    const id = await putFile(
      fixture,
      fixture.organizationId,
      own(fixture),
      "mine",
    );
    const path = "/v1/storage/files/" + id + "/content";

    // An organization I am not a member of, in the query.
    const stranger = crypto.randomUUID();
    const nonMember = await media(
      fixture,
      path + "?organizationId=" + stranger,
    );
    assert(
      nonMember.status === 403 || nonMember.status === 404,
      String(nonMember.status),
    );
    assert(!(await nonMember.text()).includes("mine"));

    const foreign = await createWorkerScope(fixture, "storage-445-q", fixture);
    try {
      // Another organization's file id, with my own organization in the query:
      // not found, exactly as with the header.
      const theirs = await putFile(
        fixture,
        foreign.organizationId,
        "/users/" + fixture.principalId + "/uploads/theirs.txt",
        "theirs",
      );
      await refused(
        await media(
          fixture,
          "/v1/storage/files/" + theirs + "/content?organizationId=" +
            fixture.organizationId,
        ),
        "RESOURCE_NOT_FOUND",
      );
      // My file id with the other organization in the query: not found.
      await refused(
        await media(
          fixture,
          path + "?organizationId=" + foreign.organizationId,
        ),
        "RESOURCE_NOT_FOUND",
      );
      // Header and query differ: refused, even though each alone names an
      // organization I belong to.
      await refused(
        await media(
          fixture,
          path + "?organizationId=" + foreign.organizationId,
          {
            "Bakery-Organization-Id": fixture.organizationId,
          },
        ),
        "RESOURCE_NOT_FOUND",
      );
      // Header and query agree: served.
      await status(
        await media(
          fixture,
          path + "?organizationId=" + fixture.organizationId,
          {
            "Bakery-Organization-Id": fixture.organizationId,
          },
        ),
        200,
      );
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    }
  }));

Deno.test("an action that does not declare the query never reads it", () =>
  withWorkerFixture(async (fixture) => {
    await putFile(fixture, fixture.organizationId, own(fixture), "mine");
    const roots = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_entries where organization_id = $1 and system_key = $2",
      [fixture.organizationId, "user:" + fixture.principalId],
    );
    assert(roots.rows[0], "my personal folder exists");
    const response = await media(
      fixture,
      "/v1/storage/folders/" + roots.rows[0].id + "/entries?organizationId=" +
        fixture.organizationId,
    );
    // storageFolderEntries.list still needs the header: the query is ignored.
    const text = await response.text();
    assert(response.status >= 400, response.status + " " + text);
    assertEquals((JSON.parse(text) as Json).code, "SCOPE_REQUIRED", text);
  }));
