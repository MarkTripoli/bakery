/**
 * The real Bakery API on a real test database, for the browser proof of the
 * repository rules pages (apps/web/tests/organization-repository-rules-real-api
 * .spec.ts). The page's requests are forwarded to it unchanged; nothing about
 * Bakery is stubbed.
 *
 * Usage: deno run -A --config deno.json
 *   tests/helpers/repository-rules-server.child.ts
 *
 * The API keeps the test public origin (`authTestOrigin`); a caller sends that
 * Origin. Prints one JSON line: the API URL, the control URL, the public
 * origin, the seeded Admin's and Developer's session cookies and the
 * organization id. The control server does what a person does outside the
 * page, through the same real API:
 *
 * - POST /publish {expectedRevision, entries}: the Admin publishes a rule
 *   revision; answers the HTTP status and body.
 * - GET /state: the published revisions as the database holds them.
 * - GET /probe?who=admin|developer&path=/v1/...: a read of that path as that
 *   person; answers the HTTP status, the problem code, if any, and the body.
 * - POST /repository {owner, name}: inserts an application and a repository
 *   directly (there is no endpoint that creates one without a Git provider);
 *   answers its id.
 * - POST /profile {repositoryId, revision, repositoryRules?,
 *   expectedOrganizationRulesRevision?}: the Admin creates a repository
 *   profile, which is how a repository overrides the organization's rules;
 *   answers the HTTP status and body.
 *
 * Runs until stdin closes or SIGTERM, then removes what it seeded.
 */
import process from "node:process";
import { authTestOrigin } from "./auth.ts";
import { call } from "./account-settings.ts";
import { openInstallationFixture } from "./installation-settings.ts";
import { baseProfileConfig } from "./repository-rule-entries.ts";
import { profileBody } from "./repository-rules-fixture.ts";

const f = await openInstallationFixture(true);

async function control(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/state") {
    const rows = await f.pgDatabase.query<
      { revision: number; digest: string; entries: number }
    >(
      `select revision, digest, jsonb_array_length(config -> 'entries') as entries
         from bakery.organization_repository_rule_versions
        where organization_id = $1
        order by revision`,
      [f.organizationId],
    );
    return Response.json({ versions: rows.rows });
  }
  if (request.method === "GET" && path === "/probe") {
    const query = new URL(request.url).searchParams;
    const cookie = query.get("who") === "developer"
      ? f.developerCookie
      : f.adminCookie;
    const response = await call(f, "GET", query.get("path") ?? "/", cookie, {
      headers: { "Bakery-Organization-Id": f.organizationId },
    });
    const text = await response.text();
    const parsed = text.length > 0 ? JSON.parse(text) as { code?: string } : {};
    return Response.json({
      status: response.status,
      code: parsed.code ?? null,
      body: text.length > 0 ? parsed : null,
    });
  }
  if (request.method === "POST" && path === "/repository") {
    const { owner, name } = await request.json() as {
      owner: string;
      name: string;
    };
    const applicationId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, $4)`,
      [
        applicationId,
        f.organizationId,
        `app-${applicationId}`,
        "Rules application",
      ],
    );
    await f.pgDatabase.query(
      `insert into bakery.repositories (
         id, organization_id, application_id, integration_connection_id,
         provider_repo_id, owner, name, default_branch
       ) values ($1, $2, $3, $4, $5, $6, $7, 'main')`,
      [
        repositoryId,
        f.organizationId,
        applicationId,
        crypto.randomUUID(),
        `repo-${repositoryId}`,
        owner,
        name,
      ],
    );
    return Response.json({ repositoryId });
  }
  if (request.method === "POST" && path === "/profile") {
    const input = await request.json() as {
      repositoryId: string;
      revision: number;
      repositoryRules?: unknown;
      expectedOrganizationRulesRevision?: number;
    };
    const version = (await f.pgDatabase.query<{ version: number }>(
      "select version from bakery.repositories where id = $1",
      [input.repositoryId],
    )).rows[0]?.version;
    const response = await call(
      f,
      "POST",
      `/v1/repositories/${input.repositoryId}/profiles`,
      f.adminCookie,
      {
        body: await profileBody(
          input.revision,
          {
            ...baseProfileConfig,
            ...(input.repositoryRules === undefined
              ? {}
              : { repositoryRules: input.repositoryRules }),
          },
          input.expectedOrganizationRulesRevision,
        ),
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
          "Bakery-Organization-Id": f.organizationId,
          "If-Match": `"${version}"`,
        },
      },
    );
    const text = await response.text();
    return Response.json({
      status: response.status,
      body: text.length > 0 ? JSON.parse(text) : null,
    });
  }
  const body = request.method === "POST"
    ? await request.json().catch(() => null) as
      | { expectedRevision: number; entries: unknown[] }
      | null
    : null;
  if (body === null) {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (path === "/publish") {
    const response = await call(
      f,
      "POST",
      `/v1/organizations/${f.organizationId}/repository-rule-versions`,
      f.adminCookie,
      {
        body: {
          expectedRevision: body.expectedRevision,
          entries: body.entries,
        },
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
          // The action must agree with the path on its organization.
          "Bakery-Organization-Id": f.organizationId,
        },
      },
    );
    const text = await response.text();
    return Response.json({
      status: response.status,
      body: text.length > 0 ? JSON.parse(text) : null,
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

const api = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  (request, info) => f.app.fetch(request, { remoteAddr: info.remoteAddr }),
);
const controller = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  control,
);
console.log(JSON.stringify({
  apiUrl: `http://127.0.0.1:${api.addr.port}`,
  controlUrl: `http://127.0.0.1:${controller.addr.port}`,
  publicOrigin: authTestOrigin,
  adminCookie: f.adminCookie,
  developerCookie: f.developerCookie,
  organizationId: f.organizationId,
}));
const stop = Promise.withResolvers<void>();
// Portable `node:process`, not Deno-only signal and stdin APIs: serve until the
// spec closes stdin or the process is told to stop.
process.once("SIGTERM", () => stop.resolve());
process.once("SIGINT", () => stop.resolve());
process.stdin.on("end", () => stop.resolve());
process.stdin.on("close", () => stop.resolve());
process.stdin.resume();
try {
  await stop.promise;
} finally {
  await api.shutdown();
  await controller.shutdown();
  await f.finish();
}
