import { assert, assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";

type Skill = {
  id: string;
  sourceId: string;
  slug: string;
  name: string;
  activeVersionId: string | null;
  scope: "global" | "organization" | "personal";
  ownerPrincipalId: string | null;
  copiedFromSkillId: string | null;
  copiedFromVersionId: string | null;
  version: number;
};

function base64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("copying a skill carries its active version and records where it came from", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-42-skill-copy-" });
  const fixture = await openAuthFixture({ skillFileRoot: root });
  const suffix = crypto.randomUUID();
  const email = `skill-copy-admin-${suffix}@example.test`;
  const otherEmail = `skill-copy-dev-${suffix}@example.test`;
  const password = `SkillCopy-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill Copy Admin", password });
    const scope = await fixture.pgDatabase.query<{
      organizationId: string;
      principalId: string;
    }>(
      `select membership.organization_id as "organizationId",
              membership.principal_id as "principalId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const { organizationId, principalId } = scope.rows[0];
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200);
    const adminCookie = sessionCookie(signIn);

    // A second member of the same organization: a Developer, not an Admin.
    const otherUserId = crypto.randomUUID();
    const otherPrincipalId = crypto.randomUUID();
    const otherToken = `skill-copy-${crypto.randomUUID()}`;
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) values ($1, 'Developer Member', $2, true, $3, $3)`,
      [otherUserId, otherEmail, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       ) values ($1, $2, 'Developer Member', 'human')`,
      [otherPrincipalId, otherUserId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
      [crypto.randomUUID(), organizationId, otherPrincipalId, now],
    );
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        otherToken,
        otherUserId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const developerCookie = await signSessionCookie(
      otherToken,
      fixture.config.auth!.secret,
    );

    const post = (
      cookie: string,
      path: string,
      body: Record<string, unknown>,
      key: string,
    ) =>
      fixture.app.fetch(authRequest(path, body, {
        cookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": key,
        },
      }));
    const get = (cookie: string, path: string) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          headers: { cookie, "Bakery-Organization-Id": organizationId },
        }),
      );

    // A published organization skill with two files to copy.
    const createResponse = await post(
      adminCookie,
      "/v1/skills",
      { slug: "research", name: "Research" },
      "create-research",
    );
    assertEquals(
      createResponse.status,
      201,
      await createResponse.clone().text(),
    );
    const source = await createResponse.json() as Skill;
    const instructions = new TextEncoder().encode("# Research\\nAsk first.\\n");
    const reference = new TextEncoder().encode("Sources: primary first.\\n");
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: instructions.byteLength,
        sha256: await sha256(instructions),
        isExecutable: false,
      }, {
        path: "references/sources.md",
        mediaType: "text/markdown",
        sizeBytes: reference.byteLength,
        sha256: await sha256(reference),
        isExecutable: false,
      }],
    };
    const publishBody = {
      revision: 1,
      digest: await sha256(canonicalJson(manifest)),
      entryPath: "SKILL.md",
      manifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(instructions),
      }, {
        path: "references/sources.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(reference),
      }],
    };
    const publish = await post(
      adminCookie,
      `/v1/skills/${source.id}/versions`,
      publishBody,
      "publish-research-v1",
    );
    assertEquals(publish.status, 201, await publish.clone().text());
    const sourceRow = { sourceId: source.sourceId };
    const sourceVersion = await publish.json() as {
      id: string;
      digest: string;
    };

    // A Developer copies it into a Private skill: new identity, owned by them,
    // the source's version as version 1, and the lineage recorded.
    const copyBody = { name: "Research (mine)", scope: "personal" };
    const copied = await post(
      developerCookie,
      `/v1/skills/${source.id}/copy`,
      copyBody,
      "copy-research-private",
    );
    assertEquals(copied.status, 201, await copied.clone().text());
    const mine = await copied.json() as Skill;
    assertEquals(mine.scope, "personal");
    assertEquals(mine.ownerPrincipalId, otherPrincipalId);
    assertEquals(mine.slug, "research-mine");
    assertEquals(mine.copiedFromSkillId, source.id);
    assertEquals(mine.copiedFromVersionId, sourceVersion.id);
    assert(mine.activeVersionId !== null);
    assert(mine.activeVersionId !== sourceVersion.id);

    // Its version is the source's content under its own ids, readable from the
    // store, and the source is untouched.
    const files = await fixture.pgDatabase.query<
      { path: string; objectKey: string; sha256: string; sizeBytes: number }
    >(
      `select path, object_key as "objectKey", sha256, size_bytes as "sizeBytes"
         from bakery.skill_files
        where organization_id = $1 and skill_version_id = $2
        order by path`,
      [organizationId, mine.activeVersionId],
    );
    assertEquals(files.rows.map((row) => row.path), [
      "SKILL.md",
      "references/sources.md",
    ]);
    const store = new SkillFileStore(root);
    for (const [index, expected] of [instructions, reference].entries()) {
      const row = files.rows[index];
      assert(row.objectKey.includes(mine.activeVersionId));
      assertEquals(
        Array.from(await store.read(row.objectKey, row.sha256, row.sizeBytes)),
        Array.from(expected),
      );
    }
    const copyVersion = await fixture.pgDatabase.query<
      { digest: string; revision: number }
    >(
      `select digest, revision from bakery.skill_versions where id = $1`,
      [mine.activeVersionId],
    );
    assertEquals(copyVersion.rows[0], {
      digest: sourceVersion.digest,
      revision: 1,
    });
    const sourceAfter =
      await (await get(adminCookie, `/v1/skills/${source.id}`))
        .json() as Skill;
    assertEquals(sourceAfter.activeVersionId, sourceVersion.id);
    assertEquals(sourceAfter.version, 2);

    // The copy is Private: its owner sees it, nobody else does, and an Admin
    // cannot copy it either.
    assertEquals(
      (await get(developerCookie, `/v1/skills/${mine.id}`)).status,
      200,
    );
    assertEquals((await get(adminCookie, `/v1/skills/${mine.id}`)).status, 404);
    const foreign = await post(
      adminCookie,
      `/v1/skills/${mine.id}/copy`,
      { name: "Taken", scope: "organization" },
      "copy-foreign-private",
    );
    assertEquals(foreign.status, 404);

    // The same delivery again is one copy; the same slug on a new delivery is
    // a conflict, and the slug can be chosen.
    const replay = await post(
      developerCookie,
      `/v1/skills/${source.id}/copy`,
      copyBody,
      "copy-research-private",
    );
    assertEquals(replay.status, 201);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals((await replay.json() as Skill).id, mine.id);
    const clash = await post(
      developerCookie,
      `/v1/skills/${source.id}/copy`,
      copyBody,
      "copy-research-private-again",
    );
    assertEquals(clash.status, 409, await clash.clone().text());
    const named = await post(
      developerCookie,
      `/v1/skills/${source.id}/copy`,
      { ...copyBody, slug: "research-two" },
      "copy-research-private-named",
    );
    assertEquals(named.status, 201, await named.clone().text());
    const count = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.skills
        where organization_id = $1 and copied_from_skill_id = $2`,
      [organizationId, source.id],
    );
    assertEquals(count.rows[0].count, "2");

    // An organization copy needs an Admin.
    const developerOrganization = await post(
      developerCookie,
      `/v1/skills/${source.id}/copy`,
      { name: "Research (org)", scope: "organization" },
      "copy-research-org-developer",
    );
    assertEquals(developerOrganization.status, 403);
    const adminOrganization = await post(
      adminCookie,
      `/v1/skills/${source.id}/copy`,
      { name: "Research (org)", scope: "organization" },
      "copy-research-org-admin",
    );
    assertEquals(
      adminOrganization.status,
      201,
      await adminOrganization.clone().text(),
    );
    const organizationCopy = await adminOrganization.json() as Skill;
    assertEquals(organizationCopy.scope, "organization");
    assertEquals(organizationCopy.ownerPrincipalId, null);

    // A skill that was switched off, or whose source was, cannot be copied into a
    // new enabled skill.
    for (
      const [table, column, id] of [
        ["skills", "id", source.id],
        ["skill_sources", "id", sourceRow.sourceId],
      ] as const
    ) {
      await fixture.pgDatabase.query(
        `update bakery.${table} set enabled = false where ${column} = $1`,
        [id],
      );
      const off = await post(
        adminCookie,
        `/v1/skills/${source.id}/copy`,
        { name: "Research (off)", scope: "organization", slug: `off-${table}` },
        `copy-while-off-${table}`,
      );
      assertEquals(off.status, 409, await off.clone().text());
      await fixture.pgDatabase.query(
        `update bakery.${table} set enabled = true where ${column} = $1`,
        [id],
      );
    }

    // A skill that comes with Bakery can be copied but never changed.
    await fixture.pgDatabase.query(
      `update bakery.skills set scope = 'global' where id = $1`,
      [source.id],
    );
    const fromGlobal = await post(
      adminCookie,
      `/v1/skills/${source.id}/copy`,
      { name: "Research (from Bakery)", scope: "organization" },
      "copy-from-global",
    );
    assertEquals(fromGlobal.status, 201, await fromGlobal.clone().text());
    assertEquals(
      (await fromGlobal.json() as Skill).copiedFromSkillId,
      source.id,
    );
    const rename = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${source.id}`, {
        method: "PATCH",
        headers: {
          cookie: adminCookie,
          "Bakery-Organization-Id": organizationId,
          "content-type": "application/json",
          "Idempotency-Key": "rename-global",
          "If-Match": '"2"',
          origin: authTestOrigin,
        },
        body: JSON.stringify({ name: "Changed" }),
      }),
    );
    assertEquals(rename.status, 403);
    // The page names this refusal from the skill itself: scope is "global".
    const publishToGlobal = await post(
      adminCookie,
      `/v1/skills/${source.id}/versions`,
      { ...publishBody, revision: 2 },
      "publish-to-global",
    );
    assertEquals(
      publishToGlobal.status,
      403,
      await publishToGlobal.clone().text(),
    );
    void principalId;
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email, otherEmail]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});
