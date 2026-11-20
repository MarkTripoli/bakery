/**
 * #14 slice 2: POST /v1/context-packs through the real app and a real
 * database. The route is the only place the session, the permission and the
 * organization scope meet, so these cases pin what the unit tests cannot: a
 * signed-in member builds a pack over a real artifact version, an anonymous
 * call or an access token does not, and another organization's version is
 * never read.
 */

import { assert, assertEquals } from "@std/assert";
import { retentionFixture } from "../helpers/artifact-retention.ts";
import { mintToken } from "../helpers/access-tokens.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
  seedEligibleJob,
} from "../helpers/worker-execution.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

type Fixture = Awaited<ReturnType<typeof retentionFixture>>;
type Json = Record<string, unknown>;

const ENVELOPE = {
  modelContextTokens: 200_000,
  counts: {},
  reserved: {
    output: 8_000,
    toolResults: 4_000,
    compaction: 4_000,
    safetyMargin: 2_000,
  },
};

function buildPack(
  fixture: Fixture,
  candidates: unknown[],
  options: { cookie?: string | null; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: fixture.config.publicBaseUrl,
    "Bakery-Organization-Id": fixture.organizationId,
  };
  if (options.bearer !== undefined) {
    headers.Authorization = "Bearer " + options.bearer;
  } else if (options.cookie !== null) {
    headers.Cookie = options.cookie ?? fixture.adminCookie;
  }
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + "/v1/context-packs", {
      method: "POST",
      headers,
      body: JSON.stringify({ envelope: ENVELOPE, candidates }),
    }),
  ));
}

function artifactCandidate(itemId: string, artifactVersionId: string) {
  return {
    itemId,
    kind: "artifact",
    artifactVersionId,
    startByte: 0,
    maxBytes: 4_096,
  };
}

async function json(response: Response): Promise<Json> {
  return await response.json() as Json;
}

Deno.test("a signed-in member builds a pack over a real artifact version", async () => {
  const fixture = await retentionFixture();
  try {
    const response = await buildPack(fixture, [
      artifactCandidate("evidence", fixture.versionId),
      { itemId: "note", kind: "text", text: "a caller note" },
    ]);
    assertEquals(response.status, 200);
    const pack = await json(response);
    assertEquals(pack.omitted, []);
    const items = pack.items as Array<Json>;
    assertEquals(items.map((item) => item.itemId), ["evidence", "note"]);
    const [evidence] = items;
    assertEquals(evidence.kind, "text_window");
    assertEquals(
      String(evidence.text).includes("Immutable retention evidence"),
      true,
    );
    // The citation pins the version, the digest and the raw byte range.
    const citation = evidence.citation as Json;
    assertEquals(citation.versionId, fixture.versionId);
    assertEquals(citation.sha256, fixture.sha256);
    assertEquals(citation.location, {
      startByte: 0,
      endByteExclusive: fixture.content.byteLength,
    });
    assert(typeof pack.packDigest === "string");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("an anonymous call and an access token are refused, and nothing is built", async () => {
  const fixture = await retentionFixture();
  try {
    const candidates = [artifactCandidate("evidence", fixture.versionId)];
    const anonymous = await buildPack(fixture, candidates, { cookie: null });
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();

    // The access token reads the file routes the command line calls and
    // nothing else: it is not a way to build a pack.
    const token = await mintToken(
      fixture as unknown as Parameters<typeof mintToken>[0],
      undefined,
      ["bakery:read"],
      "pack read token",
    );
    const bearer = await buildPack(fixture, candidates, {
      cookie: null,
      bearer: token.secret,
    });
    assertEquals(bearer.status, 401);
    await bearer.body?.cancel();
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("another organization's version and a missing one are omitted as not found, and the rest still builds", async () => {
  const fixture = await retentionFixture();
  const foreign = await createWorkerScope(fixture, "pack-14", fixture);
  try {
    // An artifact version in the other organization, readable by the same
    // person there but not through this organization.
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      foreign.organizationId,
      fixture.principalId,
    );
    const artifactId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      "insert into bakery.artifacts(id,organization_id,task_id,artifact_type,name) values($1,$2,$3,'plan','Foreign')",
      [artifactId, foreign.organizationId, job.taskId],
    );
    const content = new TextEncoder().encode("another organization's secret");
    const foreignVersionId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_versions(id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class)
       values($1,$2,$3,$4,$5,1,$6,$7,$8,'text/plain','evidence')`,
      [
        foreignVersionId,
        foreign.organizationId,
        artifactId,
        job.taskId,
        fixture.principalId,
        content,
        await sha256Bytes(content),
        content.length,
      ],
    );

    const response = await buildPack(fixture, [
      artifactCandidate("mine", fixture.versionId),
      artifactCandidate("theirs", foreignVersionId),
      artifactCandidate("missing", crypto.randomUUID()),
    ]);
    assertEquals(response.status, 200);
    const pack = await json(response);
    assertEquals(
      (pack.items as Array<Json>).map((item) => item.itemId),
      ["mine"],
    );
    assertEquals(pack.omitted, [
      { itemId: "theirs", reason: "not_found" },
      { itemId: "missing", reason: "not_found" },
    ]);
    assertEquals(
      JSON.stringify(pack).includes("another organization's secret"),
      false,
    );
  } finally {
    await closeWorkerOrganization(fixture.pgDatabase, foreign.organizationId);
    await fixture.closeRetention();
  }
});
