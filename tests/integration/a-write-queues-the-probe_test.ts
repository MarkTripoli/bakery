/**
 * #437 slice 4: a write queues the probe in its own transaction.
 *
 * The runner is only half the trigger. The other half is that the moment bytes
 * exist, something says "ask about these" -- inside the write, so a version
 * cannot be committed unqueued, and without probing, so a write never waits for a
 * sandbox. A queued subject is asked about once however many times it is written:
 * the queue's uniqueness is what keeps a re-upload from becoming a second probe.
 */

import { assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

function call(
  fixture: Fixture,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
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
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ));
}

async function requests(fixture: Fixture) {
  const { rows } = await fixture.pgDatabase.query<
    { blob_id: string | null; entry_id: string | null; revision: number | null }
  >(
    `select blob_id, entry_id, revision from bakery.probe_requests
      where organization_id = $1 order by requested_at, id`,
    [fixture.organizationId],
  );
  return rows;
}

Deno.test("writing a file queues one probe for that version, and nothing is probed on the write", () =>
  withWorkerFixture(async (fixture) => {
    const put = await call(fixture, "PUT", "/v1/storage/files", {
      path: "/shared/queued.txt",
      content: btoa("queue me"),
      mediaType: "text/plain",
    });
    assertEquals(put.status, 200);
    const file = await put.json() as { id: string; version: number };
    const version = await fixture.pgDatabase.query<
      { revision: number; blob_id: string | null }
    >(
      `select revision, blob_id from bakery.storage_file_versions
        where organization_id = $1 and entry_id = $2`,
      [fixture.organizationId, file.id],
    );
    assertEquals(version.rows.length, 1);
    const queued = await requests(fixture);
    assertEquals(queued.length, 1);
    // The bytes are inline, so the subject is the version itself: a blob key would
    // collide with every other file whose content happens to match.
    assertEquals(queued[0].blob_id, null);
    assertEquals(queued[0].entry_id, file.id);
    assertEquals(Number(queued[0].revision), Number(version.rows[0].revision));

    // The write answered in full without a probe: no answer exists yet, because a
    // sandbox is a background thing and a write is not going to wait for one.
    const probe = await call(
      fixture,
      "GET",
      "/v1/storage/files/" + file.id + "/probe?organizationId=" +
        fixture.organizationId,
    );
    assertEquals(probe.status, 200);
    assertEquals((await probe.json() as { status: unknown }).status, null);

    // Writing the same content again is a new version with the same bytes inline,
    // so it is queued once more -- for itself, not for the earlier revision.
    const again = await call(
      fixture,
      "PUT",
      "/v1/storage/files",
      {
        path: "/shared/queued.txt",
        content: btoa("queue me too"),
        mediaType: "text/plain",
      },
      // The entry's version, not the file version: a replace needs the entry as
      // it is now.
      { "If-Match": '"' + file.version + '"' },
    );
    assertEquals(again.status, 200);
    const after = await requests(fixture);
    assertEquals(after.length, 2);
    assertEquals(
      after.filter((row) => row.entry_id === file.id).length,
      2,
      "each inline version is its own subject",
    );
  }));
