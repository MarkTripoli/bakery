import { assert, assertEquals } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import { postgresErrorCode } from "../../apps/server/src/platform/postgres-errors.ts";
import { AgentVersionCreateConfigSchema } from "../../packages/contracts/src/contracts.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

const databaseConfig = readTestDatabaseConfig();

type SendOptions = {
  cookie?: string;
  organizationId?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
};

type FactCounts = {
  definitions: number;
  audit: number;
  events: number;
  replay: number;
  outbox: number;
};

async function databaseCount(
  database: ReturnType<typeof openPgDatabase>,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await database.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? 0);
}

async function counts(
  database: ReturnType<typeof openPgDatabase>,
  organizationId: string,
): Promise<FactCounts> {
  const values = [organizationId];
  return {
    definitions: await databaseCount(
      database,
      "select count(*) from bakery.workflow_definitions where organization_id = $1",
      values,
    ),
    audit: await databaseCount(
      database,
      `select count(*) from bakery.audit_events
        where organization_id = $1
          and operation in ('workflows.create', 'workflows.update')`,
      values,
    ),
    events: await databaseCount(
      database,
      `select count(*) from bakery.domain_events
        where organization_id = $1
          and event_type in ('workflows.created', 'workflows.updated')`,
      values,
    ),
    replay: await databaseCount(
      database,
      `select count(*) from bakery.idempotency_records
        where organization_id = $1
          and operation in ('workflows.create', 'workflows.update')`,
      values,
    ),
    outbox: await databaseCount(
      database,
      "select count(*) from bakery.outbox where organization_id = $1",
      values,
    ),
  };
}

async function resetDatabase(): Promise<void> {
  const reset = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(reset, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(reset);
  }
}

Deno.test("manage workflow definitions and version reads through the mounted PostgreSQL API", async (test) => {
  await resetDatabase();

  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  const runtime = fixture.runtimePgDatabase;
  const now = new Date("2026-10-04T12:00:00.000Z");
  const sessionExpiresAt = new Date(Date.now() + 86_400_000);
  const organizationAId = crypto.randomUUID();
  const organizationBId = crypto.randomUUID();
  const identity = (label: string, organizationId: string, role: string) => ({
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: `${label}-${crypto.randomUUID()}`,
    email: `${label}-${crypto.randomUUID()}@example.test`,
    name: label,
    organizationId,
    role,
  });
  const adminA = identity("admin-a", organizationAId, "admin");
  const developerA = identity("developer-a", organizationAId, "developer");
  const adminB = identity("admin-b", organizationBId, "admin");

  try {
    for (
      const [organizationId, name, slug] of [
        [organizationAId, "Organization A", `org-a-${organizationAId}`],
        [organizationBId, "Organization B", `org-b-${organizationBId}`],
      ] as const
    ) {
      await owner`
        insert into bakery.organizations (
          id, name, slug, metadata, created_at, updated_at, version
        ) values (
          ${organizationId}, ${name}, ${slug}, '{}'::jsonb,
          ${now}, ${now}, 1
        )`;
    }
    for (const who of [adminA, developerA, adminB]) {
      await owner`
        insert into public."user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        ) values (
          ${who.userId}, ${who.name}, ${who.email}, true, ${now}, ${now}
        )`;
      await owner`
        insert into public.session (
          id, token, "userId", "expiresAt", "createdAt", "updatedAt"
        ) values (
          ${crypto.randomUUID()}, ${who.token}, ${who.userId},
          ${sessionExpiresAt}, ${now}, ${now}
        )`;
      await owner`
        insert into bakery.principals (
          id, provider_user_id, display_name, principal_type
        ) values (${who.principalId}, ${who.userId}, ${who.name}, 'human')`;
      await owner`
        insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at, version
        ) values (
          ${crypto.randomUUID()}, ${who.organizationId}, ${who.principalId},
          ${who.role}, 'active', ${now}, ${now}, ${now}, 1
        )`;
    }

    const secret = fixture.config.auth!.secret;
    const cookies = {
      adminA: await signSessionCookie(adminA.token, secret),
      developerA: await signSessionCookie(developerA.token, secret),
      adminB: await signSessionCookie(adminB.token, secret),
    };
    const send = (
      method: string,
      path: string,
      options: SendOptions = {},
    ): Promise<Response> | Response => {
      const headers = new Headers();
      if (options.cookie) headers.set("cookie", options.cookie);
      if (options.organizationId) {
        headers.set("Bakery-Organization-Id", options.organizationId);
      }
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
        headers.set("origin", authTestOrigin);
      }
      if (options.idempotencyKey) {
        headers.set("Idempotency-Key", options.idempotencyKey);
      }
      if (options.ifMatch) headers.set("If-Match", options.ifMatch);
      return fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        }),
      );
    };
    const command = (overrides: Partial<SendOptions> = {}): SendOptions => ({
      cookie: cookies.adminA,
      organizationId: organizationAId,
      idempotencyKey: crypto.randomUUID(),
      ...overrides,
    });
    const read = (cookie: string, organizationId: string): SendOptions => ({
      cookie,
      organizationId,
    });
    const expectNoFacts = async (
      request: () => Promise<Response> | Response,
      expectedStatus: number,
    ): Promise<Response> => {
      const before = await counts(runtime, organizationAId);
      const response = await request();
      assertEquals(response.status, expectedStatus);
      assertEquals(await counts(runtime, organizationAId), before);
      return response;
    };

    let workflowId = "";
    await test.step("5a-1 create, get, list, update with compare-and-set", async () => {
      const unauthenticated = await send("GET", "/v1/workflows", {
        organizationId: organizationAId,
      });
      assertEquals(unauthenticated.status, 401);
      const developerCreate = await send("POST", "/v1/workflows", {
        cookie: cookies.developerA,
        organizationId: organizationAId,
        idempotencyKey: crypto.randomUUID(),
        body: { slug: "forbidden", name: "Forbidden", description: "" },
      });
      assertEquals(developerCreate.status, 403);

      const created = await send(
        "POST",
        "/v1/workflows",
        command({
          idempotencyKey: "workflow-create-1",
          body: {
            slug: "release-flow",
            name: "Release flow",
            description: "Synthetic release workflow.",
          },
        }),
      );
      assertEquals(created.status, 201);
      const createdBody = await created.json() as Record<string, unknown>;
      workflowId = createdBody.id as string;
      assertEquals(createdBody.slug, "release-flow");
      assertEquals(createdBody.activeVersionId, null);
      assertEquals(createdBody.enabled, true);
      assertEquals(createdBody.version, 1);
      assertEquals(await counts(runtime, organizationAId), {
        definitions: 1,
        audit: 1,
        events: 1,
        replay: 1,
        outbox: 0,
      });

      const duplicateSlug = await expectNoFacts(
        () =>
          send(
            "POST",
            "/v1/workflows",
            command({
              body: { slug: "release-flow", name: "Again", description: "" },
            }),
          ),
        409,
      );
      assertEquals(
        (await duplicateSlug.json() as { code: string }).code,
        "STATE_CONFLICT",
      );

      const got = await send(
        "GET",
        `/v1/workflows/${workflowId}`,
        read(cookies.developerA, organizationAId),
      );
      assertEquals(got.status, 200);
      assertEquals((await got.json() as { id: string }).id, workflowId);

      const listed = await send(
        "GET",
        "/v1/workflows",
        read(cookies.developerA, organizationAId),
      );
      assertEquals(listed.status, 200);
      assertEquals(
        (await listed.json() as { items: { id: string }[] }).items.map((
          item,
        ) => item.id),
        [workflowId],
      );

      await expectNoFacts(
        () =>
          send(
            "PATCH",
            `/v1/workflows/${workflowId}`,
            command({ body: { name: "No precondition" } }),
          ),
        428,
      );
      const updated = await send(
        "PATCH",
        `/v1/workflows/${workflowId}`,
        command({
          body: { name: "Release coordinator", enabled: false },
          ifMatch: '"1"',
        }),
      );
      assertEquals(updated.status, 200);
      const updatedBody = await updated.json() as Record<string, unknown>;
      assertEquals(updatedBody.name, "Release coordinator");
      assertEquals(updatedBody.enabled, false);
      assertEquals(updatedBody.version, 2);
      assertEquals(updatedBody.slug, "release-flow");
      const after = await counts(runtime, organizationAId);
      assertEquals(after.audit, 2);
      assertEquals(after.events, 2);
      assertEquals(after.outbox, 0);
      await expectNoFacts(
        () =>
          send(
            "PATCH",
            `/v1/workflows/${workflowId}`,
            command({ body: { enabled: true }, ifMatch: '"1"' }),
          ),
        412,
      );
    });

    await test.step("5a-2 replay returns stored response; changed body is 422", async () => {
      const options = command({
        idempotencyKey: "workflow-create-replay",
        body: { slug: "replay-flow", name: "Replay", description: "" },
      });
      const first = await send("POST", "/v1/workflows", options);
      assertEquals(first.status, 201);
      const firstText = await first.text();
      const afterFirst = await counts(runtime, organizationAId);
      const replay = await send("POST", "/v1/workflows", options);
      assertEquals(replay.status, 201);
      assertEquals(await replay.text(), firstText);
      assertEquals(await counts(runtime, organizationAId), afterFirst);
      const mismatch = await expectNoFacts(
        () =>
          send("POST", "/v1/workflows", {
            ...options,
            body: { slug: "replay-other", name: "Other", description: "" },
          }),
        422,
      );
      assertEquals(
        (await mismatch.json() as { code: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
    });

    await test.step("version reads project a published row and the draft", async () => {
      const spec = { kind: "fixed", steps: [] };
      const specDigest = await sha256Hex(canonicalJson(spec));
      const publishedId = crypto.randomUUID();
      const draftId = crypto.randomUUID();
      await owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by
        ) values (
          ${publishedId}, ${organizationAId}, ${workflowId}, 1, 'kind: fixed',
          ${owner.json(spec)}, ${specDigest}, 'published',
          ${adminA.principalId}
        )`;
      await owner`
        insert into bakery.workflow_drafts (
          id, organization_id, workflow_id, revision, source_yaml, definition,
          digest, created_by, updated_by
        ) values (
          ${draftId}, ${organizationAId}, ${workflowId}, 2, 'kind: fixed',
          ${owner.json(spec)}, ${specDigest}, ${adminA.principalId},
          ${adminA.principalId}
        )`;
      const listed = await send(
        "GET",
        `/v1/workflows/${workflowId}/versions`,
        read(cookies.developerA, organizationAId),
      );
      assertEquals(listed.status, 200);
      const page = await listed.json() as {
        items: { id: string; revision: number; status: string }[];
      };
      assertEquals(
        page.items.map(({ id, revision, status }) => [id, revision, status]),
        [[draftId, 2, "draft"], [publishedId, 1, "published"]],
      );
      for (
        const [id, status] of [[publishedId, "published"], [draftId, "draft"]]
      ) {
        const got = await send(
          "GET",
          `/v1/workflows/${workflowId}/versions/${id}`,
          read(cookies.developerA, organizationAId),
        );
        assertEquals(got.status, 200);
        const body = await got.json() as Record<string, unknown>;
        assertEquals(body.status, status);
        assertEquals(body.normalizedSpec, spec);
        assertEquals(body.digest, specDigest);
      }
      const foreign = await send(
        "GET",
        `/v1/workflows/${workflowId}/versions/${publishedId}`,
        read(cookies.adminB, organizationBId),
      );
      assertEquals(foreign.status, 404);
    });

    await test.step("5a-3 cross-org access is a 404 without an existence oracle", async () => {
      const randomId = crypto.randomUUID();
      const strip = async (response: Response) => {
        const body = await response.json() as Record<string, unknown>;
        return { status: response.status, code: body.code, title: body.title };
      };
      for (
        const suffix of ["", "/versions", `/versions/${crypto.randomUUID()}`]
      ) {
        const foreign = await send(
          "GET",
          `/v1/workflows/${workflowId}${suffix}`,
          read(cookies.adminB, organizationBId),
        );
        const unknown = await send(
          "GET",
          `/v1/workflows/${randomId}${suffix}`,
          read(cookies.adminB, organizationBId),
        );
        assertEquals(foreign.status, 404);
        assertEquals(await strip(foreign), await strip(unknown));
      }
      const foreignPatch = await send(
        "PATCH",
        `/v1/workflows/${workflowId}`,
        {
          cookie: cookies.adminB,
          organizationId: organizationBId,
          idempotencyKey: crypto.randomUUID(),
          ifMatch: '"1"',
          body: { name: "Hijack" },
        },
      );
      assertEquals(foreignPatch.status, 404);
      const missingOrg = await send("GET", "/v1/workflows", {
        cookie: cookies.adminA,
      });
      assertEquals(missingOrg.status, 403);
    });

    await test.step("5a-4 discovery routes still answer beside the workflow routes", async () => {
      const discovery = await send(
        "GET",
        "/v1/workflow-actions",
        read(cookies.adminA, organizationAId),
      );
      assertEquals(discovery.status, 200);
      const body = await discovery.json() as { items: unknown[] };
      assert(body.items.length > 0);
    });

    const validDefinition = {
      kind: "fixed",
      steps: [{ id: "first", uses: "workflow.noop" }],
    };
    const draftCounts = async () => ({
      audit: await databaseCount(
        runtime,
        `select count(*) from bakery.audit_events
          where organization_id = $1 and operation like 'workflowVersions.%'`,
        [organizationAId],
      ),
      events: await databaseCount(
        runtime,
        `select count(*) from bakery.domain_events
          where organization_id = $1 and event_type like 'workflow.version_%'`,
        [organizationAId],
      ),
      outbox: await databaseCount(
        runtime,
        "select count(*) from bakery.outbox where organization_id = $1",
        [organizationAId],
      ),
    });
    const createWorkflow = async (slug: string): Promise<string> => {
      const response = await send(
        "POST",
        "/v1/workflows",
        command({ body: { slug, name: slug, description: "" } }),
      );
      assertEquals(response.status, 201);
      return (await response.json() as { id: string }).id;
    };
    const idempotencyRows = (operation: string) =>
      databaseCount(
        runtime,
        `select count(*) from bakery.idempotency_records
          where organization_id = $1 and operation = $2`,
        [organizationAId, operation],
      );

    await test.step("5b-1 concurrent saves with one If-Match: one 200, one 412, recoverable", async () => {
      const id = await createWorkflow("race-flow");
      const created = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { definition: validDefinition } }),
      );
      assertEquals(created.status, 201);
      const draft = await created.json() as {
        id: string;
        revision: number;
        status: string;
        version: number;
      };
      assertEquals(draft.status, "draft");
      assertEquals(draft.revision, 1);
      assertEquals(draft.version, 1);
      const bodies = [
        { definition: { ...validDefinition, note: "a" } },
        { definition: { ...validDefinition, note: "b" } },
      ];
      const results = await Promise.all(bodies.map((body) =>
        send(
          "PATCH",
          `/v1/workflows/${id}/versions/${draft.id}`,
          command({ body, ifMatch: '"1"' }),
        )
      ));
      const statuses = results.map((response) => response.status).sort();
      assertEquals(statuses, [200, 412]);
      const winnerIndex = results.findIndex((response) =>
        response.status === 200
      );
      const got = await send(
        "GET",
        `/v1/workflows/${id}/versions/${draft.id}`,
        read(cookies.developerA, organizationAId),
      );
      const current = await got.json() as {
        version: number;
        normalizedSpec: unknown;
      };
      assertEquals(current.version, 2);
      assertEquals(current.normalizedSpec, bodies[winnerIndex].definition);
      const loserIndex = 1 - winnerIndex;
      const retry = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draft.id}`,
        command({ body: bodies[loserIndex], ifMatch: '"2"' }),
      );
      assertEquals(retry.status, 200);
      assertEquals((await retry.json() as { version: number }).version, 3);
    });

    await test.step("5b-2 replay and key reuse; validate leaves one idempotency row and no facts", async () => {
      const id = await createWorkflow("replay-draft-flow");
      const createOptions = command({
        idempotencyKey: "draft-create-replay",
        body: { definition: validDefinition },
      });
      const first = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        createOptions,
      );
      assertEquals(first.status, 201);
      const firstText = await first.text();
      const afterCreate = await draftCounts();
      const replay = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        createOptions,
      );
      assertEquals(replay.status, 201);
      assertEquals(await replay.text(), firstText);
      assertEquals(await draftCounts(), afterCreate);
      const mismatch = await send("POST", `/v1/workflows/${id}/versions`, {
        ...createOptions,
        body: { definition: { ...validDefinition, note: "other" } },
      });
      assertEquals(mismatch.status, 422);
      assertEquals(
        (await mismatch.json() as { code: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      assertEquals(await draftCounts(), afterCreate);

      const draftId = (JSON.parse(firstText) as { id: string }).id;
      const updateOptions = command({
        idempotencyKey: "draft-update-replay",
        ifMatch: '"1"',
        body: { definition: { ...validDefinition, note: "x" } },
      });
      const updated = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draftId}`,
        updateOptions,
      );
      assertEquals(updated.status, 200);
      const updatedText = await updated.text();
      const afterUpdate = await draftCounts();
      const updateReplay = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draftId}`,
        updateOptions,
      );
      assertEquals(updateReplay.status, 200);
      assertEquals(await updateReplay.text(), updatedText);
      assertEquals(await draftCounts(), afterUpdate);

      const validateOptions = command({
        idempotencyKey: "validate-replay",
        body: { definition: validDefinition },
      });
      const rowsBefore = await idempotencyRows("workflows.validate");
      const validated = await send(
        "POST",
        "/v1/workflow-validations",
        validateOptions,
      );
      assertEquals(validated.status, 200);
      const validatedText = await validated.text();
      const validatedBody = JSON.parse(validatedText) as {
        compilerVersion: string;
        semanticDigest: string | null;
        compilerDiagnostics: unknown[];
      };
      assertEquals(typeof validatedBody.compilerVersion, "string");
      assert(Array.isArray(validatedBody.compilerDiagnostics));
      assertEquals(await idempotencyRows("workflows.validate"), rowsBefore + 1);
      assertEquals(await draftCounts(), afterUpdate);
      const validateReplay = await send(
        "POST",
        "/v1/workflow-validations",
        validateOptions,
      );
      assertEquals(validateReplay.status, 200);
      assertEquals(await validateReplay.text(), validatedText);
      assertEquals(await idempotencyRows("workflows.validate"), rowsBefore + 1);
      const validateMismatch = await send("POST", "/v1/workflow-validations", {
        ...validateOptions,
        body: { definition: { ...validDefinition, note: "other" } },
      });
      assertEquals(validateMismatch.status, 422);
      assertEquals(await draftCounts(), afterUpdate);
      // Developers may validate; the report carries the canonical digest.
      const developer = await send(
        "POST",
        "/v1/workflow-validations",
        command({
          cookie: cookies.developerA,
          body: { definition: validDefinition },
        }),
      );
      assertEquals(developer.status, 200);
      const report = await developer.json() as {
        valid: boolean;
        normalizedDigest: string;
      };
      assertEquals(report.valid, true);
      assertEquals(
        report.normalizedDigest,
        await sha256Hex(canonicalJson(validDefinition)),
      );
    });

    await test.step("5b-3 unparseable body is MALFORMED_JSON; wrong shape is MALFORMED_REQUEST", async () => {
      const id = await createWorkflow("malformed-flow");
      const raw = await fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/workflows/${id}/versions`, {
          method: "POST",
          headers: {
            cookie: cookies.adminA,
            "Bakery-Organization-Id": organizationAId,
            "content-type": "application/json",
            origin: authTestOrigin,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: "{not json",
        }),
      );
      assertEquals(raw.status, 400);
      assertEquals(
        (await raw.json() as { code: string }).code,
        "MALFORMED_JSON",
      );
      const shape = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { sourceYaml: "kind: fixed" } }),
      );
      assertEquals(shape.status, 400);
      assertEquals(
        (await shape.json() as { code: string }).code,
        "MALFORMED_REQUEST",
      );
    });

    await test.step("5b-4 draft_exists, revision_not_next, digest_mismatch", async () => {
      const id = await createWorkflow("conflict-flow");
      const wrongDigest = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({
          body: { definition: validDefinition, digest: "b".repeat(64) },
        }),
      );
      assertEquals(wrongDigest.status, 422);
      const wrongRevision = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { definition: validDefinition, revision: 7 } }),
      );
      assertEquals(wrongRevision.status, 409);
      const ok = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({
          body: {
            definition: validDefinition,
            revision: 1,
            digest: await sha256Hex(canonicalJson(validDefinition)),
          },
        }),
      );
      assertEquals(ok.status, 201);
      const second = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { definition: validDefinition } }),
      );
      assertEquals(second.status, 409);
      const problem = await second.json() as {
        code: string;
        params?: { reason?: string };
      };
      assertEquals(problem.code, "STATE_CONFLICT");
      // Cross-org create and update are 404.
      const foreign = await send("POST", `/v1/workflows/${id}/versions`, {
        cookie: cookies.adminB,
        organizationId: organizationBId,
        idempotencyKey: crypto.randomUUID(),
        body: { definition: validDefinition },
      });
      assertEquals(foreign.status, 404);
      // A published row is immutable.
      const publishedId = crypto.randomUUID();
      const spec = { kind: "fixed", steps: [] };
      const otherId = await createWorkflow("immutable-flow");
      await owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by
        ) values (
          ${publishedId}, ${organizationAId}, ${otherId}, 1, 'kind: fixed',
          ${owner.json(spec)}, ${await sha256Hex(canonicalJson(spec))},
          'published', ${adminA.principalId}
        )`;
      const immutable = await send(
        "PATCH",
        `/v1/workflows/${otherId}/versions/${publishedId}`,
        command({ body: { definition: validDefinition }, ifMatch: '"1"' }),
      );
      assertEquals(immutable.status, 409);
    });

    await test.step("5b-5 semantic errors save; validate reports pointers without values", async () => {
      const id = await createWorkflow("invalid-flow");
      const invalid = {
        kind: "fixed",
        steps: [{ id: "first", uses: "secret.value.action" }],
      };
      const saved = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { definition: invalid } }),
      );
      assertEquals(saved.status, 201);
      const response = await send(
        "POST",
        "/v1/workflow-validations",
        command({ body: { definition: invalid } }),
      );
      assertEquals(response.status, 200);
      const text = await response.text();
      const report = JSON.parse(text) as {
        valid: boolean;
        errors: { path: string; code: string }[];
        normalizedDigest: string | null;
      };
      assertEquals(report.valid, false);
      assertEquals(report.normalizedDigest, null);
      assert(report.errors.some((error) => error.path === "/steps/0/uses"));
      assert(!text.includes("secret.value.action"));
    });

    await test.step("5b-6 a disabled definition still allows authoring", async () => {
      const id = await createWorkflow("disabled-flow");
      const disabled = await send(
        "PATCH",
        `/v1/workflows/${id}`,
        command({ body: { enabled: false }, ifMatch: '"1"' }),
      );
      assertEquals(disabled.status, 200);
      const created = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { definition: validDefinition } }),
      );
      assertEquals(created.status, 201);
      const draftId = (await created.json() as { id: string }).id;
      const saved = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draftId}`,
        command({ body: { definition: validDefinition }, ifMatch: '"1"' }),
      );
      assertEquals(saved.status, 200);
      const validated = await send(
        "POST",
        "/v1/workflow-validations",
        command({ body: { definition: validDefinition } }),
      );
      assertEquals(validated.status, 200);
    });

    type Problem = {
      code: string;
      reason?: string;
      issues?: { path: unknown; code: string }[];
    };
    const problemOf = async (response: Response): Promise<Problem> => {
      const body = await response.json() as Record<string, unknown>;
      const params = (body.params ?? {}) as Record<string, unknown>;
      return {
        code: String(body.code),
        reason: (body.reason ?? params.reason) as string | undefined,
        issues: (body.issues ?? params.issues) as Problem["issues"],
      };
    };
    const newDraft = async (
      workflow: string,
      definition: unknown,
    ): Promise<string> => {
      const created = await send(
        "POST",
        `/v1/workflows/${workflow}/versions`,
        command({ body: { definition } }),
      );
      assertEquals(created.status, 201);
      return (await created.json() as { id: string }).id;
    };
    const publish = (
      workflow: string,
      draftId: string,
      options: Partial<SendOptions> = {},
    ) =>
      send(
        "POST",
        `/v1/workflows/${workflow}/versions/${draftId}/publish`,
        command({ body: {}, ifMatch: '"1"', ...options }),
      );
    const definitionVersion = async (workflow: string): Promise<number> =>
      (await (await send(
        "GET",
        `/v1/workflows/${workflow}`,
        read(cookies.adminA, organizationAId),
      )).json() as { version: number }).version;
    const activate = async (
      workflow: string,
      versionId: string,
      options: Partial<SendOptions> = {},
    ) =>
      send(
        "POST",
        `/v1/workflows/${workflow}/activations`,
        command({
          body: { versionId },
          ifMatch: `"${await definitionVersion(workflow)}"`,
          ...options,
        }),
      );
    const publishedCount = (workflow: string) =>
      databaseCount(
        runtime,
        `select count(*) from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2`,
        [organizationAId, workflow],
      );
    const draftCount = (workflow: string) =>
      databaseCount(
        runtime,
        `select count(*) from bakery.workflow_drafts
          where organization_id = $1 and workflow_id = $2`,
        [organizationAId, workflow],
      );

    await test.step("5c-1 full flow create, draft, save, validate, publish, activate", async () => {
      const id = await createWorkflow("full-flow");
      const draftId = await newDraft(id, validDefinition);
      const saved = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draftId}`,
        command({
          body: { definition: { ...validDefinition, note: "x" } },
          ifMatch: '"1"',
        }),
      );
      assertEquals(saved.status, 200);
      const validated = await send(
        "POST",
        "/v1/workflow-validations",
        command({ body: { definition: { ...validDefinition, note: "x" } } }),
      );
      assertEquals(
        ((await validated.json()) as { valid: boolean }).valid,
        true,
      );

      const missing = await publish(id, draftId, { ifMatch: undefined });
      assertEquals(missing.status, 428);
      assertEquals(await draftCount(id), 1);

      const before = await draftCounts();
      const published = await publish(id, draftId, { ifMatch: '"2"' });
      assertEquals(published.status, 200);
      const version = await published.json() as {
        id: string;
        status: string;
        revision: number;
        version: number;
      };
      assertEquals(version.id, draftId);
      assertEquals(version.status, "published");
      assertEquals(version.revision, 1);
      assertEquals(version.version, 1);
      assertEquals(await publishedCount(id), 1);
      assertEquals(await draftCount(id), 0);
      const after = await draftCounts();
      assertEquals(after.audit, before.audit + 1);
      assertEquals(after.events, before.events + 1);
      // Draft create (1) and one save (2) share this aggregate id; publish continues at 3.
      const publishedEvent = await runtime.query<{ aggregate_version: number }>(
        `select aggregate_version from bakery.domain_events
          where organization_id = $1 and aggregate_id = $2
            and event_type = 'workflow.version_published'`,
        [organizationAId, draftId],
      );
      assertEquals(
        publishedEvent.rows.map((r) => Number(r.aggregate_version)),
        [3],
      );

      const unpinned = await activate(id, crypto.randomUUID());
      assertEquals(unpinned.status, 404);
      const active = await activate(id, version.id);
      assertEquals(active.status, 200);
      const definition = await active.json() as {
        activeVersionId: string;
        version: number;
      };
      assertEquals(definition.activeVersionId, version.id);
      const stale = await activate(id, version.id, { ifMatch: '"1"' });
      assertEquals(stale.status, 412);
    });

    await test.step("5c-1b publish pins the compiler version and semantic digest of the exact definition", async () => {
      const validated = async (definition: unknown) =>
        await (await send(
          "POST",
          "/v1/workflow-validations",
          command({ body: { definition } }),
        )).json() as {
          valid: boolean;
          compilerVersion: string;
          semanticDigest: string | null;
        };
      const pinOf = async (versionId: string) =>
        (await runtime.query<
          { compiler_version: string | null; semantic_digest: string | null }
        >(
          `select compiler_version, semantic_digest
             from bakery.workflow_versions
            where organization_id = $1 and id = $2`,
          [organizationAId, versionId],
        )).rows[0];
      const publishNew = async (name: string, definition: unknown) => {
        const id = await createWorkflow(name);
        const draftId = await newDraft(id, definition);
        const published = await publish(id, draftId);
        assertEquals(published.status, 200, await published.clone().text());
        return draftId;
      };
      const noop = (id: string) => ({ id, uses: "workflow.noop", with: {} });
      const grammar = (steps: unknown[]) => ({
        apiVersion: "bakery.dev/v1",
        kind: "workflow",
        name: "pinned-flow",
        description: "Pins the compiler version and digest at publish.",
        inputs: { target: { type: "string", required: true } },
        steps,
      });

      // A legacy flat document: the compiler returns a version but no digest,
      // so nothing is pinned. Both columns are set together or not at all.
      const legacyReport = await validated(validDefinition);
      assertEquals(legacyReport.valid, true);
      assertEquals(legacyReport.semanticDigest, null);
      assertEquals(
        await pinOf(await publishNew("pin-legacy", validDefinition)),
        { compiler_version: null, semantic_digest: null },
      );

      // A flat compiler-grammar document and a nested one: each row stores
      // exactly what the compiler returned for that definition.
      for (
        const [name, definition] of [
          ["pin-flat", grammar([noop("first"), noop("second")])],
          [
            "pin-nested",
            grammar([{
              id: "choose",
              branch: {
                when: '$input.target == "prod"',
                then: [noop("on_prod")],
                else: [noop("on_dev")],
              },
            }]),
          ],
        ] as const
      ) {
        const report = await validated(definition);
        assertEquals(report.valid, true, name);
        assert(/^[0-9a-f]{64}$/.test(report.semanticDigest ?? ""), name);
        assertEquals(
          await pinOf(await publishNew(name, definition)),
          {
            compiler_version: report.compilerVersion,
            semantic_digest: report.semanticDigest,
          },
          name,
        );
      }
    });

    await test.step("5c-2 published versions are immutable", async () => {
      const id = await createWorkflow("published-immutable");
      const draftId = await newDraft(id, validDefinition);
      assertEquals((await publish(id, draftId)).status, 200);
      const patch = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draftId}`,
        command({ body: { definition: validDefinition }, ifMatch: '"1"' }),
      );
      assertEquals(patch.status, 409);
      assertEquals((await problemOf(patch)).code, "STATE_CONFLICT");
      const again = await publish(id, draftId);
      assertEquals(again.status, 409);
      assertEquals((await problemOf(again)).code, "STATE_CONFLICT");
      let sqlState: string | undefined;
      try {
        await runtime.query(
          "update bakery.workflow_versions set source_yaml = 'x' where id = $1",
          [draftId],
        );
      } catch (error) {
        sqlState = postgresErrorCode(error);
      }
      assertEquals(sqlState, "42501");
    });

    const agentAgentId = crypto.randomUUID();
    const agentVersionId = crypto.randomUUID();
    const agentConfig = AgentVersionCreateConfigSchema.parse({
      harness: "codex",
      billing: {
        provider: "preset-provider",
        billingAccountId: "preset-account-wfpub",
        model: "preset-model",
        billingRoute: "api",
        maxTokens: 1_000,
        maxUsdReservation: 1,
        pricingMetadataSnapshot: "preset-price-wfpub",
      },
    });
    await owner`
      insert into bakery.agent_definitions (id, organization_id, slug, name, description, enabled)
      values (${agentAgentId}, ${organizationAId}, 'wfpub-agent', 'Workflow publication agent', '', true)`;
    const agentDigest = await agentVersionDigest(agentConfig);
    await owner`
      insert into bakery.agent_versions (
        id, organization_id, agent_id, revision, config, digest, created_by
      ) values (
        ${agentVersionId}, ${organizationAId}, ${agentAgentId}, 1,
        ${owner.json(agentConfig)}, ${agentDigest}, ${adminA.principalId}
      )`;
    const boundDefinition = {
      kind: "fixed",
      steps: [{ id: "impl", uses: "harness.implement" }],
      agents: { "harness.implement": agentVersionId },
    };

    await test.step("5c-3 a disabled bound agent fails publish with a path array; stale digest is 409", async () => {
      const id = await createWorkflow("agent-flow");
      const draftId = await newDraft(id, boundDefinition);
      const validated = await send(
        "POST",
        "/v1/workflow-validations",
        command({ body: { definition: boundDefinition } }),
      );
      const validatedReport = await validated.json() as { valid: boolean };
      assertEquals(
        validatedReport.valid,
        true,
        JSON.stringify(validatedReport),
      );
      await owner`
        update bakery.agent_definitions set enabled = false
         where organization_id = ${organizationAId} and id = ${agentAgentId}`;
      const rejected = await publish(id, draftId);
      assertEquals(rejected.status, 422);
      const problem = await problemOf(rejected);
      assertEquals(problem.issues?.length, 1);
      assertEquals(problem.issues?.[0].code, "agent_version_unavailable");
      assertEquals(problem.issues?.[0].path, ["agents", "harness.implement"]);
      assertEquals(await publishedCount(id), 0);
      assertEquals(await draftCount(id), 1);
      const stale = await publish(id, draftId, {
        body: { expectedDigest: "a".repeat(64) },
      });
      assertEquals(stale.status, 409);
      assertEquals((await problemOf(stale)).code, "STATE_CONFLICT");
      await owner`
        update bakery.agent_definitions set enabled = true
         where organization_id = ${organizationAId} and id = ${agentAgentId}`;
      assertEquals((await publish(id, draftId)).status, 200);
    });

    await test.step("5c-3b two steps on one action: the second step's extra capability is denied by the bound policy", async () => {
      const narrowAgentId = crypto.randomUUID();
      const narrowVersionId = crypto.randomUUID();
      const narrowConfig = AgentVersionCreateConfigSchema.parse({
        ...agentConfig,
        allowedCapabilities: ["git", "shell", "web", "model"],
      });
      await owner`
        insert into bakery.agent_definitions (id, organization_id, slug, name, description, enabled)
        values (${narrowAgentId}, ${organizationAId}, 'wfpub-narrow-agent', 'Narrow policy agent', '', true)`;
      await owner`
        insert into bakery.agent_versions (
          id, organization_id, agent_id, revision, config, digest, created_by
        ) values (
          ${narrowVersionId}, ${organizationAId}, ${narrowAgentId}, 1,
          ${owner.json(narrowConfig)}, ${await agentVersionDigest(
        narrowConfig,
      )},
          ${adminA.principalId}
        )`;
      const definition = {
        kind: "fixed",
        steps: [
          { id: "first", uses: "harness.implement" },
          { id: "second", uses: "harness.implement", requires: ["browser"] },
        ],
        agents: { "harness.implement": narrowVersionId },
      };
      const validated = await send(
        "POST",
        "/v1/workflow-validations",
        command({ body: { definition } }),
      );
      const report = await validated.json() as {
        valid: boolean;
        errors?: { path: unknown; code: string }[];
      };
      assertEquals(report.valid, false, JSON.stringify(report));
      const id = await createWorkflow("narrow-policy-flow");
      const draftId = await newDraft(id, definition);
      const rejected = await publish(id, draftId);
      assertEquals(rejected.status, 422);
      const problem = await problemOf(rejected);
      assertEquals(problem.issues?.length, 2);
      assertEquals(problem.issues?.[0].code, "agent_action_capability_denied");
      assertEquals(problem.issues?.[0].path, ["agents", "harness.implement"]);
      assertEquals(problem.issues?.[1].code, "agent_action_capability_denied");
      assertEquals(problem.issues?.[1].path, ["steps", 1, "requires"]);
      assertEquals(await publishedCount(id), 0);
      assertEquals(await draftCount(id), 1);
    });

    await test.step("5c-4 semantic errors give array paths, a code and at most 20 issues", async () => {
      const id = await createWorkflow("bad-flow");
      const steps = Array.from({ length: 30 }, (_, index) => ({
        id: `s${index}`,
        uses: "secret.value.action",
      }));
      const draftId = await newDraft(id, { kind: "fixed", steps });
      const rejected = await publish(id, draftId);
      assertEquals(rejected.status, 422);
      const text = await rejected.text();
      assert(!text.includes("secret.value.action"));
      const problem = JSON.parse(text) as {
        issues?: { path: unknown; code: string }[];
        params?: { issues?: { path: unknown; code: string }[] };
      };
      const issues = problem.issues ?? problem.params?.issues ?? [];
      assertEquals(issues.length, 20);
      for (const item of issues) {
        assert(Array.isArray(item.path));
        assert(typeof item.code === "string" && item.code.length > 0);
      }
      assertEquals(await publishedCount(id), 0);
    });

    await test.step("5c-4b requires admission rejects fail publish with 422 step_requires_invalid", async () => {
      for (const requires of [["bogus"], ["git", "git"]]) {
        const id = await createWorkflow(`bad-requires-${requires.length}`);
        const draftId = await newDraft(id, {
          kind: "fixed",
          steps: [{ id: "impl", uses: "harness.implement", requires }],
        });
        const rejected = await publish(id, draftId);
        assertEquals(rejected.status, 422);
        const text = await rejected.text();
        assert(text.includes("step_requires_invalid"));
        assertEquals(await publishedCount(id), 0);
      }
    });

    await test.step("5c-5 after publish a new draft gets revision 2", async () => {
      const id = await createWorkflow("revision-flow");
      const first = await newDraft(id, validDefinition);
      assertEquals((await publish(id, first)).status, 200);
      const created = await send(
        "POST",
        `/v1/workflows/${id}/versions`,
        command({ body: { definition: validDefinition } }),
      );
      assertEquals(created.status, 201);
      const second = await created.json() as { id: string; revision: number };
      assertEquals(second.revision, 2);
      assert(second.id !== first);
      const early = await activate(id, second.id);
      assertEquals(early.status, 409);
      assertEquals((await problemOf(early)).code, "STATE_CONFLICT");
    });

    await test.step("5c-6 a preset definition is locked for every authoring mutation", async () => {
      const presetId = crypto.randomUUID();
      const presetVersionId = crypto.randomUUID();
      await owner`
        insert into bakery.workflow_definitions (id, organization_id, slug, name, description, enabled)
        values (${presetId}, ${organizationAId}, 'preset:locked-probe', 'Locked probe', '', true)`;
      await owner.unsafe(
        `insert into bakery.workflow_versions (
           id, organization_id, workflow_id, revision, source_yaml,
           normalized_spec, digest, status, created_by
         ) values ($1, $2, $3, 1, '{}', '{}'::jsonb, $4, 'published', $5)`,
        [
          presetVersionId,
          organizationAId,
          presetId,
          "b".repeat(64),
          adminA.principalId,
        ],
      );
      const attempts: Promise<Response>[] = [
        Promise.resolve(send(
          "PATCH",
          `/v1/workflows/${presetId}`,
          command({ body: { name: "renamed" }, ifMatch: '"1"' }),
        )),
        Promise.resolve(send(
          "POST",
          `/v1/workflows/${presetId}/versions`,
          command({ body: { definition: validDefinition } }),
        )),
        Promise.resolve(publish(presetId, presetVersionId)),
        Promise.resolve(activate(presetId, presetVersionId)),
      ];
      for (const response of await Promise.all(attempts)) {
        assertEquals(response.status, 409);
        assertEquals((await problemOf(response)).code, "STATE_CONFLICT");
      }
      assertEquals(await draftCount(presetId), 0);
    });

    await test.step("5c-7 a disabled definition still publishes and activates", async () => {
      const id = await createWorkflow("disabled-publish");
      const draftId = await newDraft(id, validDefinition);
      const disabled = await send(
        "PATCH",
        `/v1/workflows/${id}`,
        command({ body: { enabled: false }, ifMatch: '"1"' }),
      );
      assertEquals(disabled.status, 200);
      assertEquals((await publish(id, draftId)).status, 200);
      assertEquals((await activate(id, draftId)).status, 200);
    });
  } finally {
    try {
      await fixture.close();
    } finally {
      await resetDatabase();
    }
  }
});
