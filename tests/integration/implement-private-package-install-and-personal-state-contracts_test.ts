import { assert, assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import {
  blobObjectKey,
  SkillFileStoreError,
  type SkillObjectStore,
} from "../../apps/server/src/modules/catalog/storage-port.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";

/**
 * Private package publication end to end (#15, B14.01, slice 1).
 *
 * These drive the real routes against the real tables, so they exercise the
 * authorization path a caller does. The refusals are asserted by reading the
 * tables afterwards: a 422 that still wrote a row would be the failure that
 * matters, and checking only the status code cannot see it.
 */

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/** An object store backed by a map, with `stat` reporting what `read` verifies. */
function memoryStore(): SkillObjectStore & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putIfAbsent(objectKey, content, expectedSha256) {
      if (await sha256Bytes(content) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
      if (!objects.has(objectKey)) objects.set(objectKey, content.slice());
    },
    async read(objectKey, expectedSha256, expectedSize) {
      const found = objects.get(objectKey);
      // The real adapters throw SkillFileStoreError, so this double does too:
      // a bare Error here would let a caller that maps store failures to a
      // refusal pass in tests while returning a 500 in production.
      if (!found) throw new SkillFileStoreError("SKILL_FILE_NOT_FOUND");
      if (
        found.byteLength !== expectedSize ||
        await sha256Bytes(found) !== expectedSha256
      ) {
        throw new SkillFileStoreError("SKILL_CONTENT_INTEGRITY_FAILED");
      }
      return found;
    },
    stat(objectKey) {
      const found = objects.get(objectKey);
      return Promise.resolve(
        found === undefined ? null : { sizeBytes: found.byteLength },
      );
    },
    async recover(objectKey, expectedSha256, expectedSize) {
      const found = objects.get(objectKey);
      if (!found) throw new Error("SKILL_FILE_NOT_FOUND");
      if (found.byteLength !== expectedSize) {
        throw new Error("SKILL_FILE_SIZE_MISMATCH");
      }
      if (await sha256Bytes(found) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
    },
    async *list() {
      for (const [objectKey, content] of objects) {
        yield {
          objectKey,
          sha256: await sha256Bytes(content),
          sizeBytes: content.byteLength,
        };
      }
    },
  };
}

/**
 * Removes the colleagues a test signed up, without touching the organization.
 *
 * The bootstrap check requires exactly one user and one principal in the
 * installation, so a colleague left behind does not fail the test that created
 * it; it fails every test after it with AUTH_BOOTSTRAP_CONFLICT. Deleting the
 * organization instead would destroy the fixture's own organization, which is
 * why this removes the dependent rows and then the principal and user, and
 * leaves the organization standing.
 */
async function removeColleagues(pgDatabase: Fixture["pgDatabase"]) {
  const users = await pgDatabase.query<{ id: string }>(
    `select id from public."user"
      where email like 'plugin-colleague-%@example.test'
         or email like 'prefs-colleague-%@example.test'`,
  );
  const userIds = users.rows.map(({ id }) => id);
  if (userIds.length === 0) return;
  const principals = `
    select id from bakery.principals where provider_user_id = any($1::uuid[])`;
  await pgDatabase.query(
    `delete from bakery.organization_memberships where principal_id in (${principals})`,
    [userIds],
  );
  // Rows that name the principal and do not cascade: every request these tests
  // made as the colleague left an idempotency record.
  await pgDatabase.query(
    `delete from bakery.idempotency_records where principal_id in (${principals})`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.user_preferences where principal_id in (${principals})`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.principals where provider_user_id = any($1::uuid[])`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from public."user" where id = any($1::uuid[])`,
    [userIds],
  );
}

const withPluginFixture = (
  run: (
    fixture: Fixture,
    store: ReturnType<typeof memoryStore>,
  ) => Promise<void>,
) => {
  const store = memoryStore();
  return withWorkerFixture(async (fixture) => {
    try {
      await run(fixture, store);
    } finally {
      await removeColleagues(fixture.pgDatabase);
    }
  }, {
    skillFileStore: store,
  });
};

function call(
  fixture: Fixture,
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  ));
}

function packageBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `pkg-${crypto.randomUUID()}`,
    displayName: "A private package",
    license: "MIT",
    provenance: { author: "test suite", method: "generated" },
    ...overrides,
  };
}

/** Upload bytes through the real routes and return the version payload fields. */
async function uploadBundle(
  fixture: Fixture,
  store: ReturnType<typeof memoryStore>,
  bytes: Uint8Array,
): Promise<{ bundleObjectRef: string; bundleDigest: string }> {
  const digest = await sha256Bytes(bytes);
  const started = await call(fixture, "/v1/blobs/uploads", {
    method: "POST",
    body: {
      sha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "application/gzip",
    },
  });
  assertEquals(started.status, 201, await started.clone().text());
  const session = await started.json();
  const part = await call(
    fixture,
    `/v1/blobs/uploads/${session.id}/parts/1`,
    {
      method: "PUT",
      body: {
        sha256: await sha256Bytes(bytes),
        content: btoa(String.fromCharCode(...bytes)),
      },
    },
  );
  assertEquals(part.status, 200, await part.clone().text());
  const completed = await call(
    fixture,
    `/v1/blobs/uploads/${session.id}/complete`,
    { method: "POST", body: {} },
  );
  assertEquals(completed.status, 201, await completed.clone().text());
  const blob = await completed.json();
  assertEquals(blob.sha256, digest);
  // The bytes really are under the derived key, so the ref the version stores
  // names the object the verifier reads.
  assert(
    store.objects.has(
      `organizations/${fixture.organizationId}/blobs/sha256/${digest}`,
    ),
  );
  return {
    bundleObjectRef: blobObjectKey(fixture.organizationId, digest),
    bundleDigest: digest,
  };
}

function versionBody(
  bundle: { bundleObjectRef: string; bundleDigest: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    versionName: `1.0.${Math.floor(Math.random() * 1_000_000)}`,
    sdkRange: "^1.0.0",
    manifest: { entry: "index.html", requestedCapabilities: ["blob:read"] },
    ...bundle,
    sourceEvidence: { repository: "example/repo", commit: "deadbeef" },
    buildEvidence: { checks: ["typecheck", "lint"] },
    ...overrides,
  };
}

Deno.test("a package is created private and unlisted, and reads back", () =>
  withPluginFixture(async (fixture) => {
    const created = await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody({ name: "alpha" }),
    });
    assertEquals(created.status, 201, await created.clone().text());
    const pkg = await created.json();
    // Creation is private and unlisted by construction: neither is an input,
    // so a caller cannot publish publicly by supplying a field.
    assertEquals(pkg.visibility, "private");
    assertEquals(pkg.listingStatus, "unlisted");
    assertEquals(pkg.name, "alpha");
    assertEquals(pkg.organizationId, fixture.organizationId);

    const fetched = await call(fixture, `/v1/plugin-packages/${pkg.id}`, {
      method: "GET",
    });
    assertEquals(fetched.status, 200, await fetched.clone().text());
    assertEquals((await fetched.json()).id, pkg.id);

    const listed = await call(fixture, "/v1/plugin-packages", {
      method: "GET",
    });
    assertEquals(listed.status, 200, await listed.clone().text());
    const page = await listed.json();
    assert(page.items.some((item: { id: string }) => item.id === pkg.id));
  }));

Deno.test("a second package with the same name in one organization is refused", () =>
  withPluginFixture(async (fixture) => {
    const first = await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody({ name: "duplicate" }),
    });
    assertEquals(first.status, 201, await first.clone().text());

    const second = await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody({ name: "duplicate" }),
    });
    assertEquals(second.status, 409, await second.clone().text());
    const problem = await second.json();
    assertEquals(problem.code, "STATE_CONFLICT");

    // The name is unique per publisher, so the refusal is about this
    // organization, not about the name being taken globally.
    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_packages
        where organization_id = $1 and name = 'duplicate'`,
      [fixture.organizationId],
    );
    assertEquals(rows.rows[0].count, "1");
  }));

Deno.test("a version records the blob it verified and refuses a digest mismatch", () =>
  withPluginFixture(async (fixture, store) => {
    const pkg = await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody(),
    })).json();

    const bytes = new TextEncoder().encode("bundle bytes that are really here");
    const bundle = await uploadBundle(fixture, store, bytes);

    const published = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      { method: "POST", body: versionBody(bundle) },
    );
    assertEquals(published.status, 201, await published.clone().text());
    const version = await published.json();
    assertEquals(version.bundleDigest, bundle.bundleDigest);
    assertEquals(version.pluginPackageId, pkg.id);
    assert(version.publishedAt !== null);

    // A digest naming bytes that are not in this organization's store is
    // refused: the digest is a check, so a version cannot exist for content
    // nobody has.
    const absentDigest = "b".repeat(64);
    const refused = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      {
        method: "POST",
        body: versionBody({
          bundleObjectRef: blobObjectKey(
            fixture.organizationId,
            absentDigest,
          ),
          bundleDigest: absentDigest,
        }),
      },
    );
    assertEquals(refused.status, 404, await refused.clone().text());

    // The case the absent-object test cannot reach: an object that does exist
    // at the derived key, whose bytes do not hash to the digest the version
    // claims. A verifier that skipped hashing (or only checked the object was
    // present) would accept this, so it proves the bytes are actually read and
    // hashed rather than assumed.
    const otherBytes = new TextEncoder().encode("different bytes entirely");
    const otherDigest = await sha256Bytes(otherBytes);
    const claimedDigest = await sha256Bytes(
      new TextEncoder().encode("bytes that were never uploaded"),
    );
    store.objects.set(
      `organizations/${fixture.organizationId}/blobs/sha256/${claimedDigest}`,
      otherBytes,
    );
    const mismatched = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      {
        method: "POST",
        body: versionBody({
          bundleObjectRef: blobObjectKey(
            fixture.organizationId,
            claimedDigest,
          ),
          bundleDigest: claimedDigest,
        }),
      },
    );
    assert(
      mismatched.status >= 400 && mismatched.status < 500,
      `expected refusal for bytes that do not match the digest, got ${mismatched.status}`,
    );
    assert(otherDigest !== claimedDigest);

    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_versions
        where plugin_package_id = $1`,
      [pkg.id],
    );
    assertEquals(
      rows.rows[0].count,
      "1",
      "neither refused attempt may leave a version row",
    );
  }));

Deno.test("a bundle ref outside the organization's own key is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const pkg = await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody(),
    })).json();
    const bundle = await uploadBundle(
      fixture,
      store,
      new TextEncoder().encode("some bundle"),
    );

    // A caller naming another organization's prefix would be reading bytes it
    // has no claim to; the ref is recomputed from the digest and must match.
    const refused = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      {
        method: "POST",
        body: versionBody({
          ...bundle,
          bundleObjectRef: blobObjectKey(
            crypto.randomUUID(),
            bundle.bundleDigest,
          ),
        }),
      },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
    const problem = await refused.json();
    assertEquals(problem.code, "VALIDATION_FAILED");
  }));

Deno.test("an unreadable SDK range is refused before it is stored", () =>
  withPluginFixture(async (fixture, store) => {
    const pkg = await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody(),
    })).json();
    const bundle = await uploadBundle(
      fixture,
      store,
      new TextEncoder().encode("bundle for range check"),
    );

    // "*" would mean "every host", which is the most permissive reading
    // available. Refusing is the only safe answer for a range this host cannot
    // evaluate.
    const refused = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      {
        method: "POST",
        body: versionBody(bundle, { sdkRange: "*" }),
      },
    );
    assertEquals(refused.status, 422, await refused.clone().text());

    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_versions
        where plugin_package_id = $1`,
      [pkg.id],
    );
    assertEquals(rows.rows[0].count, "0");
  }));

/**
 * A second, real organization with its own member and its own session.
 *
 * The earlier version of this test pointed one session at a random organization
 * id, which is refused at the membership layer and so never reaches the SQL. A
 * tenant filter that was deleted would still pass that test. This builds a real
 * organization with a real member, so the request is authorized and the only
 * thing that can keep the rows apart is the query's own `organization_id`
 * predicate.
 */
async function secondOrganization(
  fixture: Fixture,
): Promise<{ organizationId: string }> {
  const suffix = crypto.randomUUID();
  // A real second organization, created through the real route by a principal
  // that is authenticated in it. Fabricating an id would be refused at the
  // membership layer, which is the gap this test exists to close: the request
  // must be authorized, so the only thing that can keep the rows apart is the
  // tenant predicate in the query itself.
  const created = await fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}/v1/organizations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        name: `Tenant B ${suffix}`,
        slug: `tenant-b-${suffix}`,
      }),
    }),
  );
  assertEquals(created.status, 201, await created.clone().text());
  const organization = await created.json();
  assert(organization.id !== fixture.organizationId);
  return { organizationId: organization.id };
}

/**
 * Removes a colleague this file signed up, without touching the organization.
 *
 * The bootstrap check requires exactly one user and one principal in the
 * installation, so a colleague left behind fails every test after the one that
 * created it. `cleanupAuthFixture` cannot be used here because it deletes the
 * organizations the colleague belongs to, which is the fixture's own.
 */
async function removeColleague(
  pgDatabase: Fixture["pgDatabase"],
  email: string,
): Promise<void> {
  const users = await pgDatabase.query<{ id: string }>(
    'select id from public."user" where email = $1',
    [email],
  );
  const userIds = users.rows.map(({ id }) => id);
  if (userIds.length === 0) return;
  await pgDatabase.query(
    `delete from bakery.organization_memberships
      where principal_id in (
        select id from bakery.principals where provider_user_id = any($1::uuid[])
      )`,
    [userIds],
  );
  // Rows that name the principal and do not cascade on delete. Idempotency in
  // particular: every request this suite made as the colleague left one.
  await pgDatabase.query(
    `delete from bakery.idempotency_records
      where principal_id in (
        select id from bakery.principals where provider_user_id = any($1::uuid[])
      )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.user_preferences
      where principal_id in (
        select id from bakery.principals where provider_user_id = any($1::uuid[])
      )`,
    [userIds],
  );
  await pgDatabase.query(
    `delete from bakery.principals where provider_user_id = any($1::uuid[])`,
    [userIds],
  );
  await pgDatabase.query(
    'delete from public."user" where id = any($1::uuid[])',
    [userIds],
  );
}

Deno.test("another organization's package is not found rather than forbidden", () =>
  withPluginFixture(async (fixture, store) => {
    const pkg = await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody(),
    })).json();
    const bytes = new TextEncoder().encode("tenant b bundle");
    const bundle = await uploadBundle(fixture, store, bytes);
    const published = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      { method: "POST", body: versionBody(bundle) },
    );
    assertEquals(published.status, 201, await published.clone().text());
    const version = await published.json();

    const second = await secondOrganization(fixture);
    // A member of the second organization, signed in there, asking for the first
    // organization's rows: authorized, so the refusal has to come from the SQL.
    const asTenantB = (
      path: string,
      init: { method: string; body?: unknown },
    ) =>
      Promise.resolve(fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}${path}`, {
          method: init.method,
          headers: {
            "Content-Type": "application/json",
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": second.organizationId,
            Cookie: fixture.adminCookie,
            "Idempotency-Key": crypto.randomUUID(),
          },
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        }),
      ));

    // Read one package across the tenant boundary.
    const readForeign = await asTenantB(`/v1/plugin-packages/${pkg.id}`, {
      method: "GET",
    });
    assertEquals(readForeign.status, 404, await readForeign.clone().text());
    const text = await readForeign.text();
    assert(!text.includes("A private package"));

    // Listing packages as the second organization: the list is the one query a
    // tenant filter is easiest to forget, because an empty page looks like an
    // answer rather than a leak.
    const listForeign = await asTenantB("/v1/plugin-packages", {
      method: "GET",
    });
    assertEquals(listForeign.status, 200, await listForeign.clone().text());
    const foreignPage = await listForeign.json();
    assertEquals(foreignPage.items.length, 0);
    assert(
      !foreignPage.items.some((item: { id: string }) => item.id === pkg.id),
    );

    // Listing versions of a package the second organization does not own.
    const listVersions = await asTenantB(
      `/v1/plugin-packages/${pkg.id}/versions`,
      { method: "GET" },
    );
    assertEquals(listVersions.status, 404, await listVersions.clone().text());

    // Publishing into somebody else's package.
    const publishForeign = await asTenantB(
      `/v1/plugin-packages/${pkg.id}/versions`,
      { method: "POST", body: versionBody(bundle) },
    );
    assertEquals(
      publishForeign.status,
      404,
      await publishForeign.clone().text(),
    );

    // And nothing was written into the first organization's package.
    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_versions
        where organization_id = $1 and plugin_package_id = $2`,
      [fixture.organizationId, pkg.id],
    );
    assertEquals(rows.rows[0].count, "1");
    assert(version.id.length > 0);
  }));

Deno.test("personal state is private to its own principal inside one organization", () =>
  withWorkerFixture(async (fixture) => {
    // AC1's preference half. `user_preferences` is already keyed by
    // (organization_id, principal_id), so what a test must prove is that the
    // route cannot be used to read or write somebody else's row: the principal
    // comes from the session, never from the request.
    const suffix = crypto.randomUUID();
    const colleagueEmail = `prefs-colleague-${suffix}@example.test`;
    const password = `Prefs-${suffix}`;
    // A second member of the SAME organization, invited by the Admin. Sign-up
    // rather than createSuperuser: the fixture already bootstrapped the
    // organization's first superuser, and a second one is a bootstrap conflict.
    const invitation = await fixture.app.fetch(authRequest(
      `/v1/organizations/${fixture.organizationId}/invitations`,
      { email: colleagueEmail, role: "developer" },
      {
        cookie: fixture.adminCookie,
        headers: { "Bakery-Organization-Id": fixture.organizationId },
      },
    ));
    assertEquals(invitation.status, 201, await invitation.clone().text());
    const signUp = await fixture.app.fetch(
      authRequest("/api/auth/sign-up/email", {
        email: colleagueEmail,
        password,
        name: "Prefs Colleague",
      }),
    );
    assertEquals(signUp.status, 200, await signUp.clone().text());
    const colleagueCookie = sessionCookie(
      await fixture.app.fetch(
        authRequest("/api/auth/sign-in/email", {
          email: colleagueEmail,
          password,
        }),
      ),
    );
    const pending = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.organization_invitations
        where organization_id = $1 and email = $2 and status = 'pending'`,
      [fixture.organizationId, colleagueEmail],
    );
    const accepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: pending.rows[0].id },
      { cookie: colleagueCookie },
    ));
    assertEquals(accepted.status, 200, await accepted.clone().text());

    const read = (cookie: string) =>
      fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}/v1/user-preferences`, {
          method: "GET",
          headers: {
            "Bakery-Organization-Id": fixture.organizationId,
            Cookie: cookie,
          },
        }),
      );

    // The Admin chooses dark for themselves, from the version they read.
    const before = await (await read(fixture.adminCookie)).json();
    const written = await fixture.app.fetch(
      new Request(`${fixture.config.publicBaseUrl}/v1/user-preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          Cookie: fixture.adminCookie,
          "Idempotency-Key": crypto.randomUUID(),
        },
        // The CAS version comes from the read, so the write is the caller's
        // own optimistic update rather than a blind overwrite.
        body: JSON.stringify({
          theme: "dark",
          expectedCasVersion: before.casVersion,
        }),
      }),
    );
    assertEquals(written.status, 200, await written.clone().text());
    assertEquals(
      (await (await read(fixture.adminCookie)).json()).theme,
      "dark",
    );

    // The colleague in the SAME organization sees their own default, not the
    // Admin's choice. A shared row would leak one member's settings to another.
    const colleagueView = await (await read(colleagueCookie)).json();
    assert(
      colleagueView.theme !== "dark",
      `a colleague's preference leaked: ${JSON.stringify(colleagueView)}`,
    );

    // Two rows, one per principal, each naming its own principal. This is what
    // makes the isolation real rather than a projection detail.
    const rows = await fixture.pgDatabase.query<
      { principal_id: string; preferences: { theme?: string } }
    >(
      `select principal_id, preferences from bakery.user_preferences
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(
      rows.rows.map((row) => row.preferences.theme).includes("dark"),
      true,
    );
    assertEquals(
      new Set(rows.rows.map((row) => row.principal_id)).size,
      rows.rows.length,
      "each preference row must belong to a distinct principal",
    );

    // Leave the installation with one user and one principal again: the
    // bootstrap check counts them, so an extra colleague would fail later tests.
    await removeColleague(fixture.pgDatabase, colleagueEmail);
  }));

Deno.test("a package list pages by cursor without repeating or losing a row", () =>
  withPluginFixture(async (fixture) => {
    const created: string[] = [];
    // Three packages is the smallest count that exercises a cursor: with a
    // page size of one, a wrong comparison either repeats the boundary row or
    // skips it, and two packages would not tell those apart from an empty page.
    for (const name of ["alpha", "beta", "gamma"]) {
      const response = await call(fixture, "/v1/plugin-packages", {
        method: "POST",
        body: packageBody({ name }),
      });
      assert(
        response.status === 200 || response.status === 201,
        `a first write of a new key must succeed: ${await response.clone()
          .text()}`,
      );
      created.push((await response.json()).id);
    }

    const first = await call(fixture, "/v1/plugin-packages?limit=1", {
      method: "GET",
    });
    assertEquals(first.status, 200, await first.clone().text());
    const firstPage = await first.json();
    assertEquals(firstPage.items.length, 1);
    assert(firstPage.nextCursor !== null);

    const seen = new Set<string>([firstPage.items[0].id]);
    let cursor: string | null = firstPage.nextCursor;
    for (let page = 0; page < 5 && cursor !== null; page++) {
      const next = await call(
        fixture,
        `/v1/plugin-packages?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { method: "GET" },
      );
      assertEquals(next.status, 200, await next.clone().text());
      const body = await next.json();
      for (const item of body.items) {
        assert(
          !seen.has(item.id),
          `cursor repeated ${item.id}, so the boundary comparison is wrong`,
        );
        seen.add(item.id);
      }
      cursor = body.nextCursor;
    }

    // Every package this test created is reached, the walk terminates, and no
    // row appears twice -- the three things a bad boundary comparison breaks.
    // The total is not asserted: other rows in this database must not be able to
    // make a correct cursor look wrong.
    assertEquals(seen.size, created.length);
    for (const id of created) assert(seen.has(id));
    assertEquals(cursor, null);
  }));

Deno.test("a cursor cannot be replayed against another package or filter", () =>
  withPluginFixture(async (fixture, store) => {
    // Two packages, each with enough versions to page. A cursor issued while
    // paging one must not be accepted by the other: a bare row id re-anchored
    // the second package's page at a row it never contained.
    const makePackage = async (name: string) => {
      const created = await call(fixture, "/v1/plugin-packages", {
        method: "POST",
        body: packageBody({ name }),
      });
      assertEquals(created.status, 201, await created.clone().text());
      const pkg = await created.json();
      for (const versionName of ["1.0.0", "1.0.1", "1.0.2"]) {
        // Fresh bytes per version: a digest is unique within a package, so three
        // versions cannot share one archive any more than two packages can.
        const bytes = new TextEncoder().encode(
          `cursor bytes ${name} ${versionName} ${crypto.randomUUID()}`,
        );
        const bundle = await uploadBundle(fixture, store, bytes);
        const version = await call(
          fixture,
          `/v1/plugin-packages/${pkg.id}/versions`,
          { method: "POST", body: versionBody(bundle, { versionName }) },
        );
        assertEquals(version.status, 201, await version.clone().text());
      }
      return pkg.id as string;
    };
    const first = await makePackage("paging-a");
    const second = await makePackage("paging-b");

    const page = await call(
      fixture,
      `/v1/plugin-packages/${first}/versions?limit=1`,
      { method: "GET" },
    );
    assertEquals(page.status, 200, await page.clone().text());
    const cursor = (await page.json()).nextCursor as string;
    assert(cursor.length > 0, "the first page offers a cursor");

    // Replaying it against the other package is refused, and refused as a
    // client error rather than by silently returning a page anchored to a row
    // from the wrong package.
    const replayed = await call(
      fixture,
      `/v1/plugin-packages/${second}/versions?limit=1&cursor=${
        encodeURIComponent(cursor)
      }`,
      { method: "GET" },
    );
    assertEquals(replayed.status, 400, await replayed.clone().text());

    // A cursor is also not a package id: swapping it for the other package's
    // cursor still works, which proves the refusal above was the binding and
    // not a broken cursor.
    const otherPage = await call(
      fixture,
      `/v1/plugin-packages/${second}/versions?limit=1`,
      { method: "GET" },
    );
    assertEquals(otherPage.status, 200);
    const otherCursor = (await otherPage.json()).nextCursor as string;
    const continued = await call(
      fixture,
      `/v1/plugin-packages/${second}/versions?limit=1&cursor=${
        encodeURIComponent(otherCursor)
      }`,
      { method: "GET" },
    );
    assertEquals(continued.status, 200, await continued.clone().text());
  }));

Deno.test("a list cursor is bound to the organization that issued it", () =>
  withPluginFixture(async (fixture) => {
    // The package list carries no filters, so `organizationId` is the only
    // thing separating one tenant's page from another's in the cursor binding.
    // A member of a second, real organization is authorized to call this list,
    // so a cursor issued in the first organization can only be refused by the
    // binding: without it, the second organization pages with a position taken
    // from rows it cannot see.
    // Two packages so that a page of one has a real continuation cursor.
    for (const name of ["cursor-tenant-a", "cursor-tenant-a-2"]) {
      const created = await call(fixture, "/v1/plugin-packages", {
        method: "POST",
        body: packageBody({ name }),
      });
      assertEquals(created.status, 201, await created.clone().text());
    }

    const firstPage = await call(fixture, "/v1/plugin-packages?limit=1", {
      method: "GET",
    });
    assertEquals(firstPage.status, 200, await firstPage.clone().text());
    const paged = (await firstPage.json()).nextCursor as string | null;
    assert(paged, "the first organization's list offers a cursor");

    const other = await secondOrganization(fixture);
    const replayed = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/plugin-packages?limit=1&cursor=${
          encodeURIComponent(paged)
        }`,
        {
          method: "GET",
          headers: {
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": other.organizationId,
            Cookie: fixture.adminCookie,
          },
        },
      ),
    );
    const problem = await replayed.clone().json();
    assertEquals(
      replayed.status,
      400,
      `another organization's cursor answered ${replayed.status} (${
        JSON.stringify(problem)
      }), expected 400`,
    );
    assertEquals(problem.code, "INVALID_CURSOR");
  }));

Deno.test("a malformed cursor is a client error, not a server error", () =>
  withPluginFixture(async (fixture) => {
    // A cursor is a value a caller can type. Before it was signed, a
    // non-uuid reached a `::uuid` cast and the request answered 500, which
    // tells the caller nothing and pages an operator.
    for (
      const cursor of [
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000",
        "%%%",
      ]
    ) {
      const response = await call(
        fixture,
        `/v1/plugin-packages?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { method: "GET" },
      );
      const problem = await response.clone().json();
      assertEquals(
        response.status,
        400,
        `cursor ${cursor} answered ${response.status} (${
          JSON.stringify(problem)
        }), expected 400`,
      );
      assert(
        problem.code !== "INTERNAL",
        `cursor ${cursor} was reported as a server error: ${
          JSON.stringify(problem)
        }`,
      );
    }
  }));

/**
 * Installs, grants and state (#15, B14.01, slice 2, AC1 and AC3).
 *
 * The install path is where a private package becomes authority, so these assert
 * the authority rather than the rows: who may install, whose state a caller can
 * read, and whether disabling really takes the grants away.
 */

const VALID_MANIFEST = {
  name: "demo-plugin",
  requestedCapabilities: ["state.read", "state.write"],
  locales: ["demo-plugin.en"],
  stateSchemaVersion: 1,
  stateNamespaces: ["settings"],
};

/** Publish one package and one version with a manifest that can be installed. */
async function publishInstallable(
  fixture: Fixture,
  store: ReturnType<typeof memoryStore>,
  manifest: Record<string, unknown> = VALID_MANIFEST,
): Promise<{ packageId: string; versionId: string }> {
  const pkg = await (await call(fixture, "/v1/plugin-packages", {
    method: "POST",
    body: packageBody(),
  })).json();
  const bytes = new TextEncoder().encode(`bundle ${crypto.randomUUID()}`);
  const bundle = await uploadBundle(fixture, store, bytes);
  const published = await call(
    fixture,
    `/v1/plugin-packages/${pkg.id}/versions`,
    { method: "POST", body: versionBody(bundle, { manifest }) },
  );
  assertEquals(published.status, 201, await published.clone().text());
  const version = await published.json();
  return { packageId: pkg.id, versionId: version.id };
}

/** A second published version of an existing package, for upgrade cases. */
async function publishSecondVersion(
  fixture: Fixture,
  store: ReturnType<typeof memoryStore>,
  published: { packageId: string },
): Promise<{ versionId: string }> {
  const bytes = new TextEncoder().encode(`bundle ${crypto.randomUUID()}`);
  const bundle = await uploadBundle(fixture, store, bytes);
  const second = await call(
    fixture,
    `/v1/plugin-packages/${published.packageId}/versions`,
    { method: "POST", body: versionBody(bundle, { manifest: VALID_MANIFEST }) },
  );
  assertEquals(second.status, 201, await second.clone().text());
  return { versionId: (await second.json()).id };
}

/** A second member of the same organization with their own session cookie. */
async function inviteColleague(
  fixture: Fixture,
  role: "developer" | "admin",
): Promise<string> {
  const suffix = crypto.randomUUID();
  const email = `plugin-colleague-${suffix}@example.test`;
  const password = `Plugin-${suffix}`;
  const invitation = await fixture.app.fetch(authRequest(
    `/v1/organizations/${fixture.organizationId}/invitations`,
    { email, role },
    {
      cookie: fixture.adminCookie,
      headers: { "Bakery-Organization-Id": fixture.organizationId },
    },
  ));
  assertEquals(invitation.status, 201, await invitation.clone().text());
  const signUp = await fixture.app.fetch(
    authRequest("/api/auth/sign-up/email", {
      email,
      password,
      name: "Colleague",
    }),
  );
  assertEquals(signUp.status, 200, await signUp.clone().text());
  const cookie = sessionCookie(
    await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    ),
  );
  const pending = await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.organization_invitations
      where organization_id = $1 and email = $2 and status = 'pending'`,
    [fixture.organizationId, email],
  );
  const accepted = await fixture.app.fetch(authRequest(
    "/api/auth/organization/accept-invitation",
    { invitationId: pending.rows[0].id },
    { cookie },
  ));
  assertEquals(accepted.status, 200, await accepted.clone().text());
  return cookie;
}

function asCookie(fixture: Fixture, cookie: string) {
  return (
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<Response> =>
    Promise.resolve(fixture.app.fetch(
      new Request(`${fixture.config.publicBaseUrl}${path}`, {
        method: init.method,
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          Cookie: cookie,
          "Idempotency-Key": crypto.randomUUID(),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    ));
}

Deno.test("an organization install needs Admin, and a Developer is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);

    // A Developer may publish a package and install one privately, but an
    // organization install changes what everybody can use.
    const developerCookie = await inviteColleague(fixture, "developer");
    const developer = asCookie(fixture, developerCookie);
    const refused = await developer("/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });
    assertEquals(refused.status, 403, await refused.clone().text());

    // The same person may install it for themselves.
    const personal = await developer("/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "personal",
      },
    });
    assertEquals(personal.status, 201, await personal.clone().text());
    const installed = await personal.json();
    assertEquals(installed.scope, "personal");
    assertEquals(
      installed.ownerPrincipalId,
      (
        await fixture.pgDatabase.query<{ principal_id: string }>(
          `select membership.principal_id from bakery.organization_memberships as membership
             join bakery.principals as principal on principal.id = membership.principal_id
             join public."user" as provider_user on provider_user.id = principal.provider_user_id
            where membership.organization_id = $1 and provider_user.email like 'plugin-colleague-%'`,
          [fixture.organizationId],
        )
      ).rows[0].principal_id,
      "a personal install is owned by the caller, not by the installer of a share",
    );

    // An Admin may install for the organization, and that install has no owner.
    const shared = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });
    assertEquals(shared.status, 201, await shared.clone().text());
    assertEquals((await shared.json()).ownerPrincipalId, null);
  }));

Deno.test("a personal install names its owner from the session, never the body", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const someoneElse = crypto.randomUUID();

    const refused = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "personal",
        ownerPrincipalId: someoneElse,
      },
    });
    assertEquals(refused.status, 422, await refused.clone().text());

    // An organization install carries no owner at all: a shared install owned by
    // one person would make that person's authority the organization's.
    const withOwner = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
        ownerPrincipalId: someoneElse,
      },
    });
    assertEquals(withOwner.status, 422, await withOwner.clone().text());
  }));

Deno.test("installing a version of another package is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await publishInstallable(fixture, store);
    const second = await publishInstallable(fixture, store);

    // The version belongs to `second`, so pairing it with `first` is refused
    // rather than silently installing a package the caller did not name.
    const refused = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: first.packageId,
        versionId: second.versionId,
        scope: "organization",
      },
    });
    assertEquals(refused.status, 404, await refused.clone().text());
  }));

Deno.test("an incompatible SDK fails activation, and no install row is written", () =>
  withPluginFixture(async (fixture, store) => {
    const pkg = await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody(),
    })).json();
    const bytes = new TextEncoder().encode("future bundle");
    const bundle = await uploadBundle(fixture, store, bytes);
    const published = await call(
      fixture,
      `/v1/plugin-packages/${pkg.id}/versions`,
      {
        method: "POST",
        body: versionBody(bundle, {
          sdkRange: "^99.0.0",
          manifest: VALID_MANIFEST,
        }),
      },
    );
    assertEquals(published.status, 201, await published.clone().text());
    const version = await published.json();

    const refused = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: pkg.id,
        versionId: version.id,
        scope: "organization",
      },
    });
    assertEquals(refused.status, 409, await refused.clone().text());

    // Activation failed safely: there is nothing to disable afterwards.
    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_installs
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(rows.rows[0].count, "0");
  }));

Deno.test("a manifest asking for a capability the host does not grant fails activation", () =>
  withPluginFixture(async (fixture, store) => {
    // Published, because publishing stores the manifest; refused at activation,
    // because that is when it would become authority.
    const published = await publishInstallable(fixture, store, {
      ...VALID_MANIFEST,
      requestedCapabilities: ["secrets.read"],
    });
    const refused = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });
    assertEquals(refused.status, 409, await refused.clone().text());
    assertEquals(
      (await refused.json()).code,
      "STATE_CONFLICT",
    );
  }));

Deno.test("shared state is written once by CAS and a stale write is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    const first = await call(
      fixture,
      `/v1/plugin-installs/${install.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { theme: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(first.status, 200, await first.clone().text());
    const written = await first.json();
    assertEquals(written.casVersion, 1);

    // A second writer that still believes version 0 must not overwrite the
    // first writer's value: that is the lost update the CAS exists to stop.
    const stale = await call(
      fixture,
      `/v1/plugin-installs/${install.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { theme: "light" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(stale.status, 409, await stale.clone().text());

    const stored = await fixture.pgDatabase.query<
      { value: { theme: string }; cas_version: number }
    >(
      `select value, cas_version from bakery.plugin_state
        where organization_id = $1 and plugin_install_id = $2`,
      [fixture.organizationId, install.id],
    );
    assertEquals(stored.rows.length, 1);
    assertEquals(stored.rows[0].value.theme, "dark");
    assertEquals(stored.rows[0].cas_version, 1);
  }));

Deno.test("state under a namespace the manifest did not declare is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    // Without this refusal the state table is an unbounded key-value store under
    // names nobody reviewed.
    const refused = await call(
      fixture,
      `/v1/plugin-installs/${install.id}/state/undeclared/theme`,
      {
        method: "PUT",
        body: {
          namespace: "undeclared",
          key: "theme",
          schemaVersion: 1,
          value: { theme: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
  }));

Deno.test("disabling revokes the grants in the same write and refuses later state", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    const grants = () =>
      fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.plugin_install_grants
          where organization_id = $1 and plugin_install_id = $2`,
        [fixture.organizationId, install.id],
      );
    // The install's authority is the manifest's, written at install time.
    assertEquals((await grants()).rows[0].count, "2");

    const disabled = await call(fixture, `/v1/plugin-installs/${install.id}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(disabled.status, 200, await disabled.clone().text());
    assertEquals((await disabled.json()).status, "disabled");
    // AC3: authority stops with the lifecycle change, not at the next sweep.
    assertEquals((await grants()).rows[0].count, "0");

    const write = await call(
      fixture,
      `/v1/plugin-installs/${install.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { theme: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(write.status, 409, await write.clone().text());
  }));

Deno.test("a personal install's state is invisible to a colleague", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const colleagueCookie = await inviteColleague(fixture, "developer");
    const colleague = asCookie(fixture, colleagueCookie);

    const mine = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "personal",
      },
    })).json();
    const wrote = await call(
      fixture,
      `/v1/plugin-installs/${mine.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { theme: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(wrote.status, 200, await wrote.clone().text());

    // The colleague cannot see the install, so they learn nothing about the
    // state either: not-found rather than forbidden, so the answer carries no
    // information about whether the row exists.
    const peek = await colleague(`/v1/plugin-installs/${mine.id}/state`, {
      method: "GET",
    });
    assertEquals(peek.status, 404, await peek.clone().text());
    const peekInstall = await colleague(`/v1/plugin-installs/${mine.id}`, {
      method: "GET",
    });
    assertEquals(peekInstall.status, 404, await peekInstall.clone().text());

    // My own read still works, and it is my row.
    const own = await call(fixture, `/v1/plugin-installs/${mine.id}/state`, {
      method: "GET",
    });
    assertEquals(own.status, 200, await own.clone().text());
    const page = await own.json();
    assertEquals(page.items.length, 1);
    assertEquals(page.items[0].value.theme, "dark");
  }));

Deno.test("a colleague gets not found on every route to somebody else's personal install", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const ownerCookie = await inviteColleague(fixture, "developer");
    const owner = asCookie(fixture, ownerCookie);
    const installed = await (await owner("/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "personal",
      },
    })).json();

    // A second person, an Admin for good measure: authority over the
    // organization is not authority over somebody's own customization.
    const colleagueCookie = await inviteColleague(fixture, "admin");
    const colleague = asCookie(fixture, colleagueCookie);

    // Every route that takes an install id must answer the same way. A 403 on
    // one and a 404 on another would confirm the install exists.
    const read = await colleague(`/v1/plugin-installs/${installed.id}`, {
      method: "GET",
    });
    assertEquals(read.status, 404, await read.clone().text());

    const patch = await colleague(`/v1/plugin-installs/${installed.id}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(
      patch.status,
      404,
      `PATCH must not leak a colleague's install: ${await patch.clone()
        .text()}`,
    );

    const state = await colleague(
      `/v1/plugin-installs/${installed.id}/state`,
      { method: "GET" },
    );
    assertEquals(state.status, 404, await state.clone().text());

    const write = await colleague(
      `/v1/plugin-installs/${installed.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { mode: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(
      write.status,
      404,
      `a PUT to a colleague's install must not leak it: ${await write
        .clone()
        .text()}`,
    );

    // The owner still sees their own install.
    const mine = await owner(`/v1/plugin-installs/${installed.id}`, {
      method: "GET",
    });
    assertEquals(mine.status, 200, await mine.clone().text());
  }));

Deno.test("a PUT to a disabled personal install answers not found, not a status conflict", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const owner = asCookie(
      fixture,
      await inviteColleague(fixture, "developer"),
    );
    const installed = await (await owner("/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "personal",
      },
    })).json();
    const disabled = await owner(`/v1/plugin-installs/${installed.id}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(disabled.status, 200, await disabled.clone().text());

    // The status check runs AFTER the owner check, so a colleague learns
    // nothing about this install: not that it exists, and not that it is off.
    const colleague = asCookie(
      fixture,
      await inviteColleague(fixture, "admin"),
    );
    const write = await colleague(
      `/v1/plugin-installs/${installed.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { mode: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(
      write.status,
      404,
      `a disabled install must not answer 409 to a colleague: ${await write
        .clone()
        .text()}`,
    );
  }));

Deno.test("re-enabling an install restores the grants its manifest declares", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    const grants = () =>
      fixture.pgDatabase.query<{ capability: string }>(
        `select capability from bakery.plugin_install_grants
          where organization_id = $1 and plugin_install_id = $2
          order by capability`,
        [fixture.organizationId, install.id],
      );
    const declared = (await grants()).rows.map((row) => row.capability);
    assertEquals(declared.length, 2);

    await call(fixture, `/v1/plugin-installs/${install.id}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals((await grants()).rows.length, 0);

    const enabled = await call(fixture, `/v1/plugin-installs/${install.id}`, {
      method: "PATCH",
      body: { status: "enabled" },
    });
    assertEquals(enabled.status, 200, await enabled.clone().text());
    assertEquals((await enabled.json()).status, "enabled");

    // An enabled install with no grants would refuse every action while
    // telling the caller it was on: the set must come back, and come back
    // equal to what the pinned manifest declares.
    assertEquals(
      (await grants()).rows.map((row) => row.capability),
      declared,
      "re-enabling must restore exactly the declared grants",
    );
  }));

Deno.test("an uninstalled install cannot be reactivated", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    const uninstalled = await call(
      fixture,
      `/v1/plugin-installs/${install.id}`,
      { method: "PATCH", body: { status: "uninstalled" } },
    );
    assertEquals(uninstalled.status, 200, await uninstalled.clone().text());

    // A new install of the same package exists now, so without this refusal the
    // partial unique index would fire inside the UPDATE and answer 500.
    await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });

    const revived = await call(
      fixture,
      `/v1/plugin-installs/${install.id}`,
      { method: "PATCH", body: { status: "enabled" } },
    );
    assertEquals(
      revived.status,
      409,
      `an uninstalled install is finished: ${await revived.clone().text()}`,
    );
  }));

Deno.test("a Developer cannot change an organization install", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const shared = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    // The access floor for update is Developer, so the live role check in the
    // action is the only Admin barrier for organization scope. This is the test
    // that proves that barrier, not just the floor.
    const developer = asCookie(
      fixture,
      await inviteColleague(fixture, "developer"),
    );
    const refused = await developer(
      `/v1/plugin-installs/${shared.id}`,
      { method: "PATCH", body: { status: "disabled" } },
    );
    assertEquals(
      refused.status,
      403,
      `a Developer must not change an organization install: ${await refused
        .clone()
        .text()}`,
    );
    assertEquals(
      (await (await call(fixture, `/v1/plugin-installs/${shared.id}`, {
        method: "GET",
      })).json()).status,
      "enabled",
      "the refusal must not have changed anything",
    );
  }));

Deno.test("a list cursor is signed and bound, so it cannot be forged or replayed", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });

    // A bare id reached Postgres as $N::uuid and answered 500, which is the
    // defect #638 sent back. A cursor is opaque and signed now, so anything
    // that is not one is a plain 400.
    for (
      const cursor of [
        "not-a-uuid",
        "00000000-0000-4000-8000-000000000001",
        crypto.randomUUID(),
        "AAAA",
      ]
    ) {
      const refused = await call(
        fixture,
        `/v1/plugin-installs?cursor=${encodeURIComponent(cursor)}`,
        { method: "GET" },
      );
      assertEquals(
        refused.status,
        400,
        `a forged cursor must be a 400, not a 500: ${await refused.clone()
          .text()}`,
      );
    }

    // A cursor issued by one organization must not page another's rows.
    const first = await call(fixture, "/v1/plugin-installs?limit=1", {
      method: "GET",
    });
    assertEquals(first.status, 200, await first.clone().text());
    const cursor = (await first.clone().json()).nextCursor;
    if (cursor) {
      // The same principal, acting in a second organization it belongs to.
      // The only thing that can keep the rows apart is the tenant binding.
      const { organizationId: otherId } = await secondOrganization(fixture);
      const replayed = await fixture.app.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/plugin-installs?limit=1&cursor=${
            encodeURIComponent(cursor)
          }`,
          {
            method: "GET",
            headers: {
              Origin: fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": otherId,
              Cookie: fixture.adminCookie,
            },
          },
        ),
      );
      assertEquals(
        replayed.status,
        400,
        `another organization must not replay a cursor: ${await replayed
          .clone()
          .text()}`,
      );
    }
  }));

Deno.test("another organization cannot reach an install by id, and its list is empty", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    // The same principal, acting in a second organization it really belongs to.
    // Every route that takes an id must answer not-found, and the list must be
    // empty: a tenant predicate that is missing from one query shows up here and
    // nowhere else, because the caller is authorized in both organizations.
    const { organizationId: otherId } = await secondOrganization(fixture);
    const asOther = (path: string, init: { method: string; body?: unknown }) =>
      fixture.app.fetch(
        new Request(`${fixture.config.publicBaseUrl}${path}`, {
          method: init.method,
          headers: {
            "Content-Type": "application/json",
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": otherId,
            Cookie: fixture.adminCookie,
            "Idempotency-Key": crypto.randomUUID(),
          },
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        }),
      );

    const read = await asOther(`/v1/plugin-installs/${install.id}`, {
      method: "GET",
    });
    assertEquals(
      read.status,
      404,
      `another organization must not read this install: ${await read.clone()
        .text()}`,
    );

    const patch = await asOther(`/v1/plugin-installs/${install.id}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(
      patch.status,
      404,
      `another organization must not change this install: ${await patch.clone()
        .text()}`,
    );

    const state = await asOther(`/v1/plugin-installs/${install.id}/state`, {
      method: "GET",
    });
    assertEquals(
      state.status,
      404,
      `another organization must not read this state: ${await state.clone()
        .text()}`,
    );

    const write = await asOther(
      `/v1/plugin-installs/${install.id}/state/settings/theme`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "theme",
          schemaVersion: 1,
          value: { mode: "dark" },
          expectedCasVersion: 0,
        },
      },
    );
    assertEquals(
      write.status,
      404,
      `another organization must not write this state: ${await write.clone()
        .text()}`,
    );

    // The list is the one route where a missing predicate returns rows instead
    // of a 404, so it is the only place a leak would look like success.
    const listed = await asOther("/v1/plugin-installs", { method: "GET" });
    assertEquals(listed.status, 200, await listed.clone().text());
    assertEquals(
      (await listed.json()).items,
      [],
      "another organization's list must not contain this install",
    );

    // And the owning organization still sees it, so the test cannot pass by
    // breaking the read for everybody.
    const mine = await call(fixture, `/v1/plugin-installs/${install.id}`, {
      method: "GET",
    });
    assertEquals(mine.status, 200, await mine.clone().text());
  }));

Deno.test("a list shows your own personal installs and never a colleague's", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const developer = asCookie(
      fixture,
      await inviteColleague(fixture, "developer"),
    );
    const personal = await (await developer("/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "personal",
      },
    })).json();

    // A personal install is somebody's own customization, so it is not
    // organization inventory: an Admin does not see it in a list. This is the
    // deliberate answer, not an omission -- the install is still reachable by
    // id for its owner, and the routes that take an id answer 404 to everyone
    // else, which is covered above.
    const adminList = await call(fixture, "/v1/plugin-installs", {
      method: "GET",
    });
    assertEquals(adminList.status, 200, await adminList.clone().text());
    const adminIds = (await adminList.json()).items.map(
      (row: { id: string }) => row.id,
    );
    assert(
      !adminIds.includes(personal.id),
      "an Admin's list must not include a Developer's personal install",
    );

    // The developer sees their own in their own list. Without this the test
    // would also pass if the list were simply broken for everybody.
    const developerList = await developer("/v1/plugin-installs", {
      method: "GET",
    });
    assertEquals(developerList.status, 200, await developerList.clone().text());
    const developerIds = (await developerList.json()).items.map(
      (row: { id: string }) => row.id,
    );
    assert(
      developerIds.includes(personal.id),
      "an owner's list must include their own personal install",
    );

    // And a second organization's list contains neither, which is the mutant
    // qa2 found surviving: dropping the organization predicate returned
    // everybody's installs and nothing noticed.
    const { organizationId: otherId } = await secondOrganization(fixture);
    const other = await fixture.app.fetch(
      new Request(`${fixture.config.publicBaseUrl}/v1/plugin-installs`, {
        method: "GET",
        headers: {
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": otherId,
          Cookie: fixture.adminCookie,
        },
      }),
    );
    assertEquals(other.status, 200, await other.clone().text());
    const otherIds = (await other.json()).items.map(
      (row: { id: string }) => row.id,
    );
    assert(
      !otherIds.includes(personal.id),
      "a second organization's list must not include this personal install",
    );
  }));

Deno.test("an install cannot grow state keys without limit", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    const write = (key: string) =>
      call(fixture, `/v1/plugin-installs/${install.id}/state/settings/${key}`, {
        method: "PUT",
        body: {
          namespace: "settings",
          key,
          schemaVersion: 1,
          value: { mode: "dark" },
          expectedCasVersion: 0,
        },
      });

    // The value size is capped by the transport schema, but the number of keys
    // was not: one plugin could add rows until the table was the problem.
    let refusedAt = 0;
    for (let index = 0; index < 300; index += 1) {
      const response = await write(`key-${index}`);
      if (response.status === 409) {
        refusedAt = index;
        break;
      }
      assert(
        response.status === 200 || response.status === 201,
        `a first write must succeed: ${await response.clone().text()}`,
      );
    }
    assert(
      refusedAt > 0 && refusedAt <= 300,
      `a key cap must refuse before 300 keys, refused at ${refusedAt}`,
    );

    // Overwriting an existing key still works at the cap: the limit is on the
    // number of keys, not on writes.
    const overwrite = await call(
      fixture,
      `/v1/plugin-installs/${install.id}/state/settings/key-0`,
      {
        method: "PUT",
        body: {
          namespace: "settings",
          key: "key-0",
          schemaVersion: 1,
          value: { mode: "light" },
          expectedCasVersion: 1,
        },
      },
    );
    assert(
      overwrite.status === 200 || overwrite.status === 201,
      `an overwrite must succeed: ${await overwrite.clone().text()}`,
    );
  }));

Deno.test("an uninstalled install cannot be repointed at another version", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    await call(fixture, `/v1/plugin-installs/${install.id}`, {
      method: "PATCH",
      body: { status: "uninstalled" },
    });

    // A version-only PATCH used to answer 200 and repoint the finished row,
    // which reads as "this install is live again" while its status says
    // otherwise. It has to name a DIFFERENT version: repeating the current one
    // is a no-op and would pass for the wrong reason.
    const second = await publishSecondVersion(fixture, store, published);
    const repointed = await call(
      fixture,
      `/v1/plugin-installs/${install.id}`,
      { method: "PATCH", body: { versionId: second.versionId } },
    );
    assertEquals(
      repointed.status,
      409,
      `an uninstalled install must not be repointed: ${await repointed.clone()
        .text()}`,
    );
  }));

Deno.test("an install refuses a draft version and a withdrawn package", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);

    // A draft is a version the publisher has not released. Creation publishes
    // today, so reach the state through the row, which is what the predicate
    // exists to guard: nothing should grant a draft's capabilities.
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set published_at = null
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.versionId],
    );
    const draft = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });
    // 404 rather than 409: from the install's side a draft version is not an
    // available version at all, and answering "conflict" would confirm that a
    // version with this id exists but is unreleased.
    assertEquals(
      draft.status,
      404,
      `a draft version must not be installable: ${await draft.clone().text()}`,
    );

    // Publish it again and withdraw the package instead; the same install must
    // still be refused, because a withdrawn package is no longer available.
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set published_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.versionId],
    );
    await fixture.pgDatabase.query(
      `update bakery.plugin_packages set listing_status = 'withdrawn'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.packageId],
    );
    const withdrawn = await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    });
    assertEquals(
      withdrawn.status,
      404,
      `a withdrawn package must not be installable: ${await withdrawn
        .clone()
        .text()}`,
    );

    // No grants were written for either attempt.
    const grants = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_install_grants
        where organization_id = $1`,
      [fixture.organizationId],
    );
    assertEquals(grants.rows[0].count, "0");
  }));

Deno.test("a concurrent upgrade cannot undo a disable and restore its grants", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishInstallable(fixture, store);
    const second = await publishSecondVersion(fixture, store, published);
    const install = await (await call(fixture, "/v1/plugin-installs", {
      method: "POST",
      body: {
        packageId: published.packageId,
        versionId: published.versionId,
        scope: "organization",
      },
    })).json();

    const grants = () =>
      fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.plugin_install_grants
          where organization_id = $1 and plugin_install_id = $2`,
        [fixture.organizationId, install.id],
      );

    // A disable and an upgrade at the same time. The upgrade decides its status
    // from the row it read; without the row lock it can read `enabled` before
    // the disable commits, then write `enabled` back and re-insert the grants,
    // losing the revocation AC3 promises happened.
    const [disabled, upgraded] = await Promise.all([
      call(fixture, `/v1/plugin-installs/${install.id}`, {
        method: "PATCH",
        body: { status: "disabled" },
      }),
      call(fixture, `/v1/plugin-installs/${install.id}`, {
        method: "PATCH",
        body: { versionId: second.versionId },
      }),
    ]);
    assertEquals(disabled.status, 200, await disabled.clone().text());
    assertEquals(upgraded.status, 200, await upgraded.clone().text());

    // Whatever the order, the disable is the last word on authority: the
    // install is off and holds no grants. An `enabled` row with grants here
    // means the upgrade resurrected an install somebody turned off.
    const final = await (await call(
      fixture,
      `/v1/plugin-installs/${install.id}`,
      { method: "GET" },
    )).json();
    assertEquals(
      final.status,
      "disabled",
      "the disable must survive a concurrent upgrade",
    );
    assertEquals(
      (await grants()).rows[0].count,
      "0",
      "a concurrent upgrade must not restore revoked grants",
    );
  }));
