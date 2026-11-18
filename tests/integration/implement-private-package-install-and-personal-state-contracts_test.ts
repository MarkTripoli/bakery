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

const withPluginFixture = (
  run: (
    fixture: Fixture,
    store: ReturnType<typeof memoryStore>,
  ) => Promise<void>,
) => {
  const store = memoryStore();
  return withWorkerFixture((fixture) => run(fixture, store), {
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
      assertEquals(response.status, 201, await response.clone().text());
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
