/**
 * #437 slice 3: the storage Files surface asks the same question the artifact
 * page asks, about the same bytes.
 *
 * The probe is keyed on the blob, so a file's answer is the answer for every
 * version that shares those bytes, and a file whose content is stored inline has
 * never been probed at all -- which is "no answer yet", not a refusal. The
 * visibility rules are the content read's own: another organization and another
 * member's personal folder are both simply not found.
 */

import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { writeBlobProbe } from "../../apps/server/src/modules/knowledge/blob-probes.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

function call(
  fixture: Fixture,
  method: string,
  path: string,
  body?: unknown,
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
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ));
}

const NEVER_PROBED = {
  status: null,
  kind: null,
  mediaType: null,
  byteLength: null,
  width: null,
  height: null,
  durationMs: null,
  lineCount: null,
  utf8: null,
  code: null,
  limit: null,
  probedAt: null,
};

Deno.test("a storage file answers what the probe measured, and nothing before it has", () =>
  withWorkerFixture(async (fixture) => {
    const put = await call(fixture, "PUT", "/v1/storage/files", {
      path: "/shared/probed.txt",
      content: btoa("probe me"),
      mediaType: "text/plain",
    });
    assertEquals(put.status, 200);
    const file = await put.json() as { id: string };
    const probe = "/v1/storage/files/" + file.id + "/probe?organizationId=" +
      fixture.organizationId;

    // Nothing has asked about these bytes yet.
    const before = await call(fixture, "GET", probe);
    assertEquals(before.status, 200);
    assertEquals(await before.json(), NEVER_PROBED);

    // A small file's bytes are stored inline, so there is no blob to ask about
    // and the answer stays "no answer yet" no matter how long it is waited on.
    const inline = await fixture.pgDatabase.query<{ blob_id: string | null }>(
      "select blob_id from bakery.storage_file_versions where organization_id = $1 and entry_id = $2",
      [fixture.organizationId, file.id],
    );
    assertEquals(inline.rows[0].blob_id, null);

    // A blob-backed version is the case the probe answers for: point the version
    // at a blob (as a blob upload would) and record what the probe measured.
    const blobId = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.blobs
         (organization_id, sha256, size_bytes, media_type, created_by_id)
       values ($1, $2, 8, 'text/plain', $3) returning id`,
      [fixture.organizationId, "a".repeat(64), fixture.principalId],
    ).then((result) => result.rows[0].id);
    await fixture.pgDatabase.query(
      "update bakery.storage_file_versions set blob_id = $3, content = null where organization_id = $1 and entry_id = $2",
      [fixture.organizationId, file.id, blobId],
    );
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      blobId,
      result: {
        status: "described",
        kind: "text",
        mediaType: "text/plain",
        byteLength: 8,
        lineCount: 1,
        utf8: true,
      },
    });

    const after = await call(fixture, "GET", probe);
    assertEquals(after.status, 200);
    const answer = await after.json() as Record<string, unknown>;
    assertEquals(answer.status, "described");
    assertEquals(answer.kind, "text");
    assertEquals(answer.mediaType, "text/plain");
    assertEquals(answer.byteLength, 8);
    assertEquals(answer.lineCount, 1);
    assertEquals(answer.utf8, true);
    // A fact the probe did not measure is absent, never zero.
    assertEquals(answer.width, null);
    assertEquals(answer.durationMs, null);
    assert(typeof answer.probedAt === "string");

    // A revision the file does not have is not found, the same as the bytes.
    assertEquals(
      (await call(fixture, "GET", probe + "&revision=9")).status,
      404,
    );
    // The current revision answers the same thing.
    const current = await call(fixture, "GET", probe + "&revision=1");
    assertEquals(current.status, 200);
    assertEquals((await current.json() as { kind: string }).kind, "text");
  }));
