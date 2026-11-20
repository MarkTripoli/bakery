import { assert, assertEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { openRepositoryRulesFixture } from "../helpers/repository-rules-fixture.ts";

function kindPath(organizationId: string) {
  return `/v1/organizations/${organizationId}/artifact-kinds`;
}

function versionPath(organizationId: string, key: string) {
  return `${kindPath(organizationId)}/${key}/versions`;
}

function definition(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    name: "Brief",
    description: "The written statement of what a piece of work is for.",
    text: true,
    facts: [{
      name: "wordCount",
      type: "integer",
      required: true,
      description: "Number of words in the brief.",
    }],
    rules: [{
      type: "maxLength",
      severity: "require",
      options: { value: 20000 },
    }],
    ...overrides,
  };
}

async function kindVersionDigest(
  key: string,
  revision: number,
  body: unknown,
): Promise<string> {
  return await sha256Hex(canonicalJson({ key, revision, definition: body }));
}

type KindVersion = {
  id: string;
  organizationId: string;
  kindId: string;
  key: string;
  revision: number;
  definition: Record<string, unknown>;
  digest: string;
  createdAt: string;
  createdBy: string | null;
};

Deno.test("publish and read immutable artifact kinds through the mounted API", async (test) => {
  const f = await openRepositoryRulesFixture();
  const { send, runtime, organizationAId, organizationBId } = f;
  const publish = (
    organizationId: string,
    key: string,
    expectedRevision: number,
    body: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ) =>
    send("POST", versionPath(organizationId, key), {
      cookie: f.cookies.adminA,
      organizationId,
      idempotencyKey,
      body: { expectedRevision, definition: body },
    });

  try {
    await test.step("AC1: publishing the first version creates the kind at revision 1", async () => {
      const response = await publish(
        organizationAId,
        "brief",
        0,
        definition("brief"),
      );
      assertEquals(response.status, 201);
      const body = await response.json() as KindVersion;
      assertEquals(body.revision, 1);
      assertEquals(body.key, "brief");
      assertEquals(body.organizationId, organizationAId);
      assertEquals(body.definition.key, "brief");
      // The caller can recompute the digest from the response, which is what
      // makes it a check rather than a value to trust.
      assertEquals(
        body.digest,
        await kindVersionDigest("brief", 1, body.definition),
      );
      const read = await send("GET", `${kindPath(organizationAId)}/brief`, {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
      });
      assertEquals(read.status, 200);
      const kind = await read.json() as Record<string, unknown>;
      assertEquals(kind.revision, 1);
      assertEquals(kind.id, body.kindId);
      assertEquals(kind.digest, body.digest);
    });

    await test.step("AC2: a definition has nowhere to put code and a stale revision writes nothing", async () => {
      const before = await runtime.query<{ count: string }>(
        "select count(*) from bakery.artifact_kind_versions where organization_id = $1",
        [organizationAId],
      );
      // A stale expected revision is refused and leaves no row behind.
      const stale = await publish(
        organizationAId,
        "brief",
        0,
        definition("brief"),
      );
      assertEquals(stale.status, 412);
      const after = await runtime.query<{ count: string }>(
        "select count(*) from bakery.artifact_kind_versions where organization_id = $1",
        [organizationAId],
      );
      assertEquals(after.rows[0]?.count, before.rows[0]?.count);
      // A rule type outside the closed platform set is refused at publication.
      const refused = await publish(
        organizationAId,
        "brief",
        1,
        definition("brief", {
          rules: [{
            type: "customerScript",
            severity: "require",
            options: {},
          }],
        }),
      );
      assertEquals(refused.status, 422);
      const problem = await refused.json() as {
        issues?: Array<{ path: (string | number)[] }>;
      };
      assert(
        problem.issues?.some((issue) => issue.path.includes("type")),
        JSON.stringify(problem),
      );
    });

    await test.step("AC1: republication appends a version and never rewrites an old one", async () => {
      const first = definition("brief");
      const second = definition("brief", { name: "Brief (v2)" });
      const response = await publish(organizationAId, "brief", 1, second);
      assertEquals(response.status, 201);
      const body = await response.json() as KindVersion;
      assertEquals(body.revision, 2);
      const versions = await send(
        "GET",
        versionPath(organizationAId, "brief"),
        { cookie: f.cookies.developerA, organizationId: organizationAId },
      );
      assertEquals(versions.status, 200);
      const page = await versions.json() as {
        items: KindVersion[];
        nextCursor: string | null;
      };
      assertEquals(page.items.map((item) => item.revision), [2, 1]);
      // Revision 1 still says what it said; history is immutable.
      assertEquals(page.items[1].definition.name, first.name);
      assertEquals(page.items[0].definition.name, "Brief (v2)");
      assertEquals(page.nextCursor, null);
      const kinds = await send("GET", kindPath(organizationAId), {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
      });
      const listed = await kinds.json() as {
        items: Array<Record<string, unknown>>;
      };
      assertEquals(listed.items.length, 1);
      assertEquals(listed.items[0].revision, 2);
    });

    await test.step("another organization's kind is not found, not forbidden", async () => {
      const read = await send("GET", `${kindPath(organizationBId)}/brief`, {
        cookie: f.cookies.adminB,
        organizationId: organizationBId,
      });
      assertEquals(read.status, 404);
      // A path organization the caller does not belong to is refused by the
      // authority runner before any row is read.
      const crossTenant = await send(
        "GET",
        `${kindPath(organizationBId)}/brief`,
        {
          cookie: f.cookies.adminA,
          organizationId: organizationBId,
        },
      );
      assertEquals(crossTenant.status, 404);
    });

    await test.step("publishing is admin-only and audited", async () => {
      const denied = await send("POST", versionPath(organizationAId, "notes"), {
        cookie: f.cookies.developerA,
        organizationId: organizationAId,
        idempotencyKey: crypto.randomUUID(),
        body: { expectedRevision: 0, definition: definition("notes") },
      });
      assertEquals(denied.status, 403);
      const audit = await runtime.query<{ count: string }>(
        "select count(*) from bakery.audit_events where organization_id = $1 and operation = 'artifactKindVersions.create'",
        [organizationAId],
      );
      assertEquals(audit.rows[0]?.count, "2");
      const events = await runtime.query<{ count: string }>(
        "select count(*) from bakery.domain_events where organization_id = $1 and event_type = 'artifactKinds.published'",
        [organizationAId],
      );
      assertEquals(events.rows[0]?.count, "2");
    });

    await test.step("a key that names the path of another kind is refused", async () => {
      const mismatch = await send(
        "POST",
        versionPath(organizationAId, "brief"),
        {
          cookie: f.cookies.adminA,
          organizationId: organizationAId,
          idempotencyKey: crypto.randomUUID(),
          body: {
            expectedRevision: 2,
            definition: definition("something-else"),
          },
        },
      );
      assertEquals(mismatch.status, 422);
      const problem = await mismatch.json() as {
        issues?: Array<{ code: string }>;
      };
      assert(
        problem.issues?.some((issue) => issue.code === "kind_key_mismatch"),
        JSON.stringify(problem),
      );
    });
  } finally {
    // The shared fixture's own close, which resets the database.
    await f.close();
  }
});
