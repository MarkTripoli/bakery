import { assert, assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import {
  blobObjectKey,
  SkillFileStoreError,
  type SkillObjectStore,
} from "../../apps/server/src/modules/catalog/storage-port.ts";
import { withWorkerFixture } from "./worker-execution/scenarios.ts";
import { authRequest, sessionCookie } from "./auth.ts";
import {
  createUstarArchive,
  gzipFixture,
} from "../fixtures/remote-skill-source.ts";

/**
 * Real-route fixtures for a plugin's own pages (#76): an in-memory bundle
 * store, publication of a version whose bundle carries page files, and a
 * colleague with their own session. Shared by the integration and security
 * files so both drive the same authorization path a caller does.
 */

export type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/** An object store backed by a map, with `stat` reporting what `read` verifies. */
export function memoryStore(): SkillObjectStore & {
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
    delete(objectKey) {
      return Promise.resolve(objects.delete(objectKey));
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
export async function removeColleagues(pgDatabase: Fixture["pgDatabase"]) {
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

export const withPluginFixture = (
  run: (
    fixture: Fixture,
    store: ReturnType<typeof memoryStore>,
  ) => Promise<void>,
  options: {
    pluginBrokerOperations?: Parameters<typeof withWorkerFixture>[1] extends
      infer O ? O extends { pluginBrokerOperations?: infer P } ? P : never
      : never;
  } = {},
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
    pluginBrokerOperations: options.pluginBrokerOperations,
  });
};

export function call(
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

export async function inviteColleague(
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

export function asCookie(fixture: Fixture, cookie: string) {
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

export async function secondOrganization(
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

const encoder = new TextEncoder();

/** A gzip USTAR bundle holding the given files. */
export async function pageBundle(files: Record<string, string>) {
  return await gzipFixture(createUstarArchive(
    Object.entries(files).map(([path, text]) => ({
      path,
      content: encoder.encode(text),
    })),
  ));
}

export const CHECKLIST_HTML =
  "<!doctype html><title>Checklist</title><script>document.title=location.search</script><p>Release checklist</p>";

export function pagesManifest(
  pages: readonly { id: string; title: string; file: string }[],
) {
  return {
    name: "release-helper",
    requestedCapabilities: ["state.read", "ui.page"],
    pages,
  };
}

/** Publish a package and one version whose bundle carries `files`. */
export async function publishWithPages(
  fixture: Fixture,
  store: ReturnType<typeof memoryStore>,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
  packageId?: string,
): Promise<{ packageId: string; versionId: string; response: Response }> {
  const pkgId = packageId ??
    (await (await call(fixture, "/v1/plugin-packages", {
      method: "POST",
      body: packageBody({ displayName: "Release helper" }),
    })).json()).id;
  const bytes = await pageBundle(files);
  const bundle = await uploadBundle(fixture, store, bytes);
  const response = await call(
    fixture,
    `/v1/plugin-packages/${pkgId}/versions`,
    {
      method: "POST",
      body: {
        versionName: `1.0.${Math.floor(Math.random() * 1_000_000)}`,
        sdkRange: "^1.0.0",
        manifest,
        ...bundle,
        sourceEvidence: { repository: "example/repo", commit: "deadbeef" },
        buildEvidence: { checks: ["typecheck"] },
      },
    },
  );
  const versionId = response.status === 201
    ? (await response.clone().json()).id
    : "";
  return { packageId: pkgId, versionId, response };
}

export async function install(
  fixture: Fixture,
  published: { packageId: string; versionId: string },
  scope: "organization" | "personal" = "organization",
  as: typeof call | ReturnType<typeof asCookie> = call,
): Promise<string> {
  const run = as === call
    ? (path: string, init: { method: string; body?: unknown }) =>
      call(fixture, path, init)
    : as as ReturnType<typeof asCookie>;
  const response = await run("/v1/plugin-installs", {
    method: "POST",
    body: {
      packageId: published.packageId,
      versionId: published.versionId,
      scope,
    },
  });
  assertEquals(response.status, 201, await response.clone().text());
  return (await response.json()).id;
}

export const RENDER = "theme=dark&locale=ar-EG&dir=rtl";
