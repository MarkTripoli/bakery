/**
 * #74 rev 4 items 4 and 5, and when a version was published (migration 0321):
 * an import may be Private, a web-address archive may be imported with no
 * version and is pinned by its content digest with an optional label, and a
 * version records when it was published (null for older ones).
 */
import { assert, assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { executeSkillImport } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import {
  createSkillSourceAdapterForTest,
  normalizeSkillSourceRevision,
  type SkillSourceAdapter,
  SkillSourceAdapterError,
  type SkillSourceFetchRequest,
  type SkillSourceProof,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  authTestOrigin,
  cleanupAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";
import {
  createRemoteSkillFixture,
  fixtureSha256,
} from "../fixtures/remote-skill-source.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Run = { id: string };
const LOCATOR = "https://example.com/skills.tar.gz";
const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A web-address archive whose content a test sets. Asked for no revision it
 * answers with the archive's digest; asked for a digest or an ETag it answers
 * with exactly that, as the real adapter does once it has checked the bytes.
 */
async function archiveSource() {
  const remote = await createRemoteSkillFixture();
  const state = { digest: "a".repeat(64) };
  const calls: SkillSourceFetchRequest[] = [];
  const adapter: SkillSourceAdapter = {
    async fetchPinnedSource(request) {
      calls.push(request);
      const revision = request.requestedRevision === ""
        ? `sha256:${state.digest}`
        : request.requestedRevision;
      const proof: SkillSourceProof = Object.freeze({
        sourceType: "url",
        normalizedLocator: request.locator,
        requestedRevision: request.requestedRevision,
        sourceRevision: revision,
        sourceProofDigest: await fixtureSha256(remote.manifestBytes),
        normalizedPath: request.path ?? "",
        inventory: Object.freeze({
          manifest: remote.manifest,
          manifestBytes: remote.manifestBytes,
          files: Object.freeze(remote.files.map((file) =>
            Object.freeze({
              path: file.path,
              content: file.content,
              isExecutable: file.isExecutable ?? false,
            })
          )),
        }),
      });
      return proof;
    },
  };
  return { state, calls, adapter };
}

const memberEmails: string[] = [];

async function addDeveloper(f: Fx) {
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `import-dev-${crypto.randomUUID()}`;
  const now = new Date();
  await f.fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Developer', $2, true, $3, $3)`,
    [userId, `${token}@example.test`, now],
  );
  memberEmails.push(`${token}@example.test`);
  await f.fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Developer', 'human')`,
    [principalId, userId],
  );
  await f.fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), f.organizationId, principalId, now],
  );
  await f.fixture.pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      userId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return {
    principalId,
    cookie: await signSessionCookie(token, f.fixture.config.auth!.secret),
  };
}

async function close(f: Fx) {
  try {
    await cleanupAuthFixture(f.fixture.pgDatabase, memberEmails.splice(0));
  } finally {
    await f.close();
  }
}

async function urlSource(f: Fx, key: string): Promise<string> {
  const response = await f.post(f.ownerCookie, "/v1/skill-sources", {
    sourceType: "url",
    url: LOCATOR,
    name: "Archive",
    license: "MIT",
  }, key);
  assertEquals(response.status, 201, await response.clone().text());
  return (await response.json() as { id: string }).id;
}

async function json<T>(response: Response, status: number): Promise<T> {
  assertEquals(response.status, status, await response.clone().text());
  return await response.json() as T;
}

Deno.test("a web-address archive's revision is a strong ETag or its content digest", () => {
  const digest = `sha256:${"0".repeat(64)}`;
  assertEquals(normalizeSkillSourceRevision("url", digest), digest);
  assertEquals(normalizeSkillSourceRevision("url", '"v1"'), '"v1"');
  for (const bad of ["sha256:xyz", "latest", `sha256:${"0".repeat(63)}`]) {
    let code: string | undefined;
    try {
      normalizeSkillSourceRevision("url", bad);
    } catch (error) {
      code = (error as SkillSourceAdapterError).code;
    }
    assertEquals(code, "SOURCE_REVISION_MISMATCH", bad);
  }
});

Deno.test("the adapter pins a web-address archive by its bytes, and keeps the ETag check when one is named", async () => {
  const body = encoder.encode("not an archive");
  const digest = `sha256:${await sha256(body)}`;
  const seen: (string | null)[] = [];
  const adapter = createSkillSourceAdapterForTest({
    httpFetch: (url, init) => {
      seen.push(init.headers.get("if-match"));
      return Promise.resolve({
        status: 200,
        url,
        headers: new Headers({ etag: '"v1"' }),
        body: new Response(body).body,
      });
    },
  });
  const outcome = async (requestedRevision: string) => {
    try {
      await adapter.fetchPinnedSource({
        sourceType: "url",
        locator: LOCATOR,
        requestedRevision,
      });
      return "ok";
    } catch (error) {
      return (error as SkillSourceAdapterError).code;
    }
  };
  // The digest matches, so the archive is read (and is not a real archive).
  assertEquals(await outcome(digest), "SOURCE_INVALID");
  // Other bytes than the pinned digest are refused before they are read.
  assertEquals(
    await outcome(`sha256:${"f".repeat(64)}`),
    "SOURCE_REVISION_MISMATCH",
  );
  assertEquals(await outcome(""), "SOURCE_INVALID");
  // An ETag still goes to the server as If-Match and must come back.
  assertEquals(await outcome('"v2"'), "SOURCE_REVISION_MISMATCH");
  assertEquals(seen, [null, null, null, '"v2"']);
});

Deno.test("a version records when it was published, and an older one says null", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-published-at-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const skill = await json<{ id: string }>(
      await f.post(f.ownerCookie, "/v1/skills", {
        slug: "dated",
        name: "Dated",
      }, "dated-skill"),
      201,
    );
    const old = await f.insertSkillVersion(skill.id);
    const text = encoder.encode("# Dated\n");
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: text.byteLength,
        sha256: await sha256(text),
        isExecutable: false,
      }],
    };
    const before = Date.now();
    const published = await json<
      { id: string; publishedAt: string | null; label: string | null }
    >(
      await f.post(f.ownerCookie, `/v1/skills/${skill.id}/versions`, {
        revision: 2,
        digest: await sha256(encoder.encode(canonicalJson(manifest))),
        entryPath: "SKILL.md",
        manifest,
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: btoa(String.fromCharCode(...text)),
        }],
      }, "dated-v2"),
      201,
    );
    assert(published.publishedAt !== null);
    assert(Date.parse(published.publishedAt) >= before - 5_000);
    assertEquals(published.label, null);
    const list = await json<
      { items: { id: string; publishedAt: string | null }[] }
    >(await f.read(f.ownerCookie, `/v1/skills/${skill.id}/versions`), 200);
    assertEquals(
      list.items.map((item) => [item.id, item.publishedAt !== null]),
      [[published.id, true], [old, false]],
    );
  } finally {
    await close(f);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a web-address archive imported with no version is pinned by its digest, carries its label, and replays while unchanged", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-archive-" });
  const store = new SkillFileStore(root);
  await store.initialize();
  const source = await archiveSource();
  const f = await openPersonalSkillFixture({
    skillFileStore: store,
    skillSourceAdapter: source.adapter,
  });
  try {
    const db = f.fixture.pgDatabase;
    const sourceId = await urlSource(f, "archive-source");
    const first = await json<Run>(
      await f.post(f.ownerCookie, "/v1/skill-imports", {
        sourceId,
        label: "Spring release",
      }, "archive-import-1"),
      201,
    );
    const pinned = `sha256:${"a".repeat(64)}`;
    const row = await db.query<{ requested_revision: string }>(
      "select requested_revision from bakery.skill_imports where run_id = $1",
      [first.id],
    );
    assertEquals(row.rows[0].requested_revision, pinned);
    assertEquals(source.calls[0]?.requestedRevision, "");

    // The same content again is the same import; changed content is a new one.
    const again = await json<Run>(
      await f.post(
        f.ownerCookie,
        "/v1/skill-imports",
        { sourceId },
        "archive-import-2",
      ),
      201,
    );
    assertEquals(again.id, first.id);
    source.state.digest = "b".repeat(64);
    const changed = await json<Run>(
      await f.post(
        f.ownerCookie,
        "/v1/skill-imports",
        { sourceId },
        "archive-import-3",
      ),
      201,
    );
    assert(changed.id !== first.id);

    // Running it publishes a version whose revision is the digest, labelled.
    const result = await executeSkillImport(first.id, {
      database: f.fixture.runtimePgDatabase,
      sourceAdapter: source.adapter,
      skillFileStore: store,
    });
    assertEquals(result.state, "completed");
    const made = await json<{ versionId: string | null }>(
      await f.read(f.ownerCookie, `/v1/skill-imports/${first.id}`),
      200,
    );
    const version = await db.query<
      {
        source_revision: string;
        label: string | null;
        published_at: Date | null;
      }
    >(
      "select source_revision, label, published_at from bakery.skill_versions where id = $1",
      [made.versionId],
    );
    assertEquals(version.rows[0].source_revision, pinned);
    assertEquals(version.rows[0].label, "Spring release");
    assert(version.rows[0].published_at !== null);

    // A named ETag is still the revision when one is given.
    const tagged = await json<Run>(
      await f.post(f.ownerCookie, "/v1/skill-imports", {
        sourceId,
        revision: '"etag-1"',
      }, "archive-import-etag"),
      201,
    );
    const taggedRow = await db.query<{ requested_revision: string }>(
      "select requested_revision from bakery.skill_imports where run_id = $1",
      [tagged.id],
    );
    assertEquals(taggedRow.rows[0].requested_revision, '"etag-1"');

    // A Git source must name what to import.
    const git = await json<{ id: string }>(
      await f.post(f.ownerCookie, "/v1/skill-sources", {
        sourceType: "git",
        url: "https://github.com/example/skills.git",
        name: "Git",
        license: "MIT",
      }, "archive-git-source"),
      201,
    );
    const unnamed = await f.post(f.ownerCookie, "/v1/skill-imports", {
      sourceId: git.id,
    }, "archive-git-import");
    assertEquals(unnamed.status, 422, await unnamed.clone().text());
  } finally {
    await close(f);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an import may be Private: its importer owns the skill, and nobody else's import replays it", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-private-import-" });
  const store = new SkillFileStore(root);
  await store.initialize();
  const source = await archiveSource();
  const f = await openPersonalSkillFixture({
    skillFileStore: store,
    skillSourceAdapter: source.adapter,
  });
  try {
    const db = f.fixture.pgDatabase;
    const developer = await addDeveloper(f);
    const sourceId = await urlSource(f, "private-source");
    const request = { sourceId, revision: '"v1"' };
    const post = (cookie: string, body: Record<string, unknown>, key: string) =>
      f.fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/skill-imports`, {
          method: "POST",
          headers: {
            cookie,
            "Bakery-Organization-Id": f.organizationId,
            "content-type": "application/json",
            origin: authTestOrigin,
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        }),
      );
    // A Developer cannot import for the organization, but can for themself.
    assertEquals(
      (await post(developer.cookie, request, "private-org")).status,
      403,
    );
    const mine = await json<Run>(
      await post(
        developer.cookie,
        { ...request, scope: "personal" },
        "private-mine",
      ),
      201,
    );
    const stored = await db.query<
      { scope: string; owner_principal_id: string | null }
    >(
      "select scope, owner_principal_id from bakery.skill_imports where run_id = $1",
      [mine.id],
    );
    assertEquals(stored.rows[0], {
      scope: "personal",
      owner_principal_id: developer.principalId,
    });
    // An Admin's import of the same source, revision and folder is their own.
    const admins = await json<Run>(
      await post(
        f.adminCookie,
        { ...request, scope: "personal" },
        "private-admin",
      ),
      201,
    );
    assert(admins.id !== mine.id);
    const organization = await json<Run>(
      await post(f.ownerCookie, request, "private-organization"),
      201,
    );
    assert(organization.id !== mine.id && organization.id !== admins.id);

    // Run, it makes a Private skill its importer alone sees.
    const result = await executeSkillImport(mine.id, {
      database: f.fixture.runtimePgDatabase,
      sourceAdapter: source.adapter,
      skillFileStore: store,
    });
    assertEquals(result.state, "completed");
    const made = await json<{ skillId: string | null }>(
      await f.read(developer.cookie, `/v1/skill-imports/${mine.id}`),
      200,
    );
    assert(made.skillId !== null);
    const skill = await json<
      { scope: string; ownerPrincipalId: string | null }
    >(await f.read(developer.cookie, `/v1/skills/${made.skillId}`), 200);
    assertEquals(skill, {
      ...skill,
      scope: "personal",
      ownerPrincipalId: developer.principalId,
    });
    assertEquals(
      (await f.read(f.adminCookie, `/v1/skills/${made.skillId}`)).status,
      404,
    );
  } finally {
    await close(f);
    await Deno.remove(root, { recursive: true });
  }
});
