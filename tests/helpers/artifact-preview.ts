import { assertEquals } from "@std/assert";
import { retentionFixture } from "./artifact-retention.ts";
import { signSessionCookie } from "./auth.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

/** Loopback host that differs from the app fixture origin (127.0.0.1). */
export const previewTestOrigin = "http://localhost:8789";

export type PreviewGrantBody = {
  grantId: string;
  grant: string;
  exchangeUrl: string;
  expiresAt: string;
  revisionPath: string;
};

/**
 * Retention fixture with a configured preview origin plus helpers that speak
 * to the application host and, separately, to the isolated preview host.
 */
export async function previewFixture(
  options: { configured?: boolean } = {},
) {
  const configured = options.configured ?? true;
  const fixture = await retentionFixture({
    env: configured
      ? { BAKERY_ARTIFACT_PREVIEW_ORIGIN: previewTestOrigin }
      : {},
  });
  // The retention seed expires in the past; previews need live bytes.
  await fixture.pgDatabase.query(
    "update bakery.artifact_versions set expires_at = null where id = $1",
    [fixture.versionId],
  );
  const appOrigin = fixture.config.publicBaseUrl;

  async function addVersion(mediaType: string, bytes: Uint8Array) {
    const id = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_versions(id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type,retention_class)
       values($1,$2,$3,$4,$5,(select coalesce(max(revision),0)+1 from bakery.artifact_versions where artifact_id=$3),$6,$7,$8,$9,'evidence')`,
      [
        id,
        fixture.organizationId,
        fixture.artifactId,
        fixture.job.taskId,
        fixture.principalId,
        bytes,
        await sha256Bytes(bytes),
        bytes.length,
        mediaType,
      ],
    );
    return id;
  }

  function appRequest(
    path: string,
    init: RequestInit = {},
    organizationId?: string,
  ) {
    const headers = new Headers(init.headers);
    headers.set("cookie", headers.get("cookie") ?? fixture.adminCookie);
    headers.set(
      "bakery-organization-id",
      organizationId ?? fixture.organizationId,
    );
    if (init.method && init.method !== "GET") {
      headers.set("origin", headers.get("origin") ?? appOrigin);
    }
    return fixture.app.fetch(
      new Request(`${appOrigin}${path}`, { ...init, headers }),
    );
  }

  function create(versionId = fixture.versionId, organizationId?: string) {
    return appRequest(
      `/v1/artifact-versions/${versionId}/preview-grants`,
      { method: "POST" },
      organizationId,
    );
  }

  function revoke(grantId: string) {
    return appRequest(`/v1/artifact-preview-grants/${grantId}`, {
      method: "DELETE",
      headers: { "idempotency-key": crypto.randomUUID() },
    });
  }

  function preview(path: string, init: RequestInit = {}) {
    return fixture.app.fetch(
      new Request(`${previewTestOrigin}${path}`, init),
    );
  }

  function exchange(grant: string, init: RequestInit = {}) {
    // The app page posts the form, so the browser sends the app origin.
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      origin: appOrigin,
    });
    for (const [name, value] of new Headers(init.headers)) {
      headers.set(name, value);
    }
    return preview("/artifact-preview/exchange", {
      method: "POST",
      body: new URLSearchParams({ grant }).toString(),
      ...init,
      headers,
    });
  }

  /** Create, exchange and return what a browser holds afterwards. */
  async function open(versionId = fixture.versionId) {
    const created = await create(versionId);
    assertEquals(created.status, 201, await created.clone().text());
    const body = await created.json() as PreviewGrantBody;
    const exchanged = await exchange(body.grant);
    assertEquals(exchanged.status, 303);
    const setCookie = exchanged.headers.get("set-cookie") ?? "";
    const location = exchanged.headers.get("location") ?? "";
    return {
      ...body,
      setCookie,
      viewPath: location,
      cookie: setCookie.split(";", 1)[0],
      view: (extra: Record<string, string> = {}) =>
        preview(location, {
          headers: { cookie: setCookie.split(";", 1)[0], ...extra },
        }),
    };
  }

  /** Another active developer in the same organization, with a live session. */
  async function addDeveloper() {
    const db = fixture.pgDatabase;
    const providerUserId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const token = `preview-dev-${crypto.randomUUID()}`;
    const now = new Date();
    await db.query(
      `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, 'Preview developer', $2, true, $3, $3)`,
      [providerUserId, `preview-dev-${providerUserId}@example.test`, now],
    );
    await db.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, $2, 'Preview developer', 'human')`,
      [principalId, providerUserId],
    );
    await db.query(
      `insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version)
       values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
      [crypto.randomUUID(), fixture.organizationId, principalId, now],
    );
    await db.query(
      `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        token,
        providerUserId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    return {
      principalId,
      cookie: await signSessionCookie(token, fixture.config.auth!.secret),
      async remove() {
        await db.query(
          'delete from public.session where "userId" = $1',
          [providerUserId],
        );
        await db.query(
          "delete from bakery.organization_memberships where principal_id = $1",
          [principalId],
        );
        await db.query("delete from bakery.principals where id = $1", [
          principalId,
        ]);
        await db.query('delete from public."user" where id = $1', [
          providerUserId,
        ]);
      },
    };
  }

  return {
    ...fixture,
    addDeveloper,
    appOrigin,
    previewOrigin: previewTestOrigin,
    addVersion,
    appRequest,
    create,
    revoke,
    preview,
    exchange,
    open,
  };
}

export type PreviewFixture = Awaited<ReturnType<typeof previewFixture>>;
