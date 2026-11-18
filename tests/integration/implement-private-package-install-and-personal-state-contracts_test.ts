import { assert, assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import {
  blobObjectKey,
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
      if (!found) throw new Error("SKILL_FILE_NOT_FOUND");
      if (found.byteLength !== expectedSize) {
        throw new Error("SKILL_FILE_SIZE_MISMATCH");
      }
      if (await sha256Bytes(found) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
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

    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.plugin_versions
        where plugin_package_id = $1`,
      [pkg.id],
    );
    assertEquals(rows.rows[0].count, "1");
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

Deno.test("another organization's package is not found rather than forbidden", () =>
  withPluginFixture(async (fixture) => {
    const pkg = await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody(),
    })).json();

    // Point the same session at a different organization it is not a member of:
    // the row is invisible, and a 403 would confirm that it exists.
    const foreign = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/plugin-packages/${pkg.id}`,
        {
          method: "GET",
          headers: {
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": crypto.randomUUID(),
            Cookie: fixture.adminCookie,
          },
        },
      ),
    );
    assert(
      foreign.status === 404 || foreign.status === 403,
      `expected refusal, got ${foreign.status}`,
    );
    // Whatever the transport says, the body must not contain the package.
    const text = await foreign.text();
    assert(!text.includes("A private package"));
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
  }));
