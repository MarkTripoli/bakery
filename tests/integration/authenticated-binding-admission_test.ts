import { assertEquals } from "@std/assert";
import {
  agentVersionDigest,
} from "../../apps/server/src/modules/agents/postgres.ts";
import { resolveAgentSkillBindings } from "../../apps/server/src/modules/catalog/agent-skill-bindings.ts";
import { deriveSkillVersionId } from "../../apps/server/src/modules/catalog/identity.ts";
import { authRequest } from "../helpers/auth.ts";
import {
  makeUpload,
  openPublicationTestContext,
} from "../helpers/local-skill-publication.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

const text = (value: string) => new TextEncoder().encode(value);

type AgentFacts = Readonly<{
  versions: number;
  audit: number;
  events: number;
  replay: number;
}>;

Deno.test("authenticated agent-version admission resolves immutable skill bindings", async (test) => {
  const root = await Deno.makeTempDir({ prefix: "bakery-binding-admission-" });
  await Deno.chmod(root, 0o700);
  const context = await openPublicationTestContext({ root });
  const { fixture, organizationId, principalId } = context;
  const headers = {
    ...context.headers,
    "content-type": "application/json",
  };
  const post = (
    path: string,
    body: unknown,
    key: string = crypto.randomUUID(),
  ) =>
    fixture.app.fetch(authRequest(path, body, {
      cookie: context.cookie,
      headers: { ...headers, "Idempotency-Key": key },
    }));
  const facts = async (): Promise<AgentFacts> => {
    const result = await fixture.runtimePgDatabase.query<{
      versions: string;
      audit: string;
      events: string;
      replay: string;
    }>(
      `select
         (select count(*) from bakery.agent_versions where organization_id = $1) as versions,
         (select count(*) from bakery.audit_events where organization_id = $1 and operation = 'agentVersions.create') as audit,
         (select count(*) from bakery.domain_events where organization_id = $1 and event_type = 'agent.version_created') as events,
         (select count(*) from bakery.idempotency_records where organization_id = $1 and operation = 'agentVersions.create') as replay`,
      [organizationId],
    );
    const row = result.rows[0]!;
    return {
      versions: Number(row.versions),
      audit: Number(row.audit),
      events: Number(row.events),
      replay: Number(row.replay),
    };
  };
  const expectRejected = async (
    agentId: string,
    config: Record<string, unknown>,
    issueCode: string,
  ) => {
    const before = await facts();
    const response = await post(`/v1/agents/${agentId}/versions`, {
      revision: 2,
      config,
      digest: await agentVersionDigest(config),
    });
    const problem = await response.json() as {
      code: string;
      issues?: Array<{ code: string; path: Array<string | number> }>;
    };
    assertEquals(response.status, 422);
    assertEquals(problem.code, "UNPROCESSABLE");
    assertEquals(problem.issues?.[0]?.code, issueCode);
    assertEquals(await facts(), before);
    return problem;
  };

  let foreignOrganizationId: string | undefined;
  try {
    const alpha = await context.createSkill("binding-alpha");
    const beta = await context.createSkill("binding-beta");
    const alphaUpload = await makeUpload([
      { path: "SKILL.md", content: text("alpha") },
    ]);
    const betaUpload = await makeUpload([
      { path: "SKILL.md", content: text("beta") },
    ]);
    const alphaPublication = await context.publish(alpha.id, alphaUpload);
    const betaPublication = await context.publish(beta.id, betaUpload);
    assertEquals(alphaPublication.status, 201);
    assertEquals(betaPublication.status, 201);
    const alphaVersion = await alphaPublication.json() as {
      id: string;
      digest: string;
    };
    const betaVersion = await betaPublication.json() as {
      id: string;
      digest: string;
    };

    const agentResponse = await post("/v1/agents", {
      slug: "binding-agent",
      name: "Binding agent",
      description: "Exercises immutable skill binding admission.",
    });
    assertEquals(agentResponse.status, 201, await agentResponse.clone().text());
    const agentId = (await agentResponse.json() as { id: string }).id;

    const validConfig = {
      harness: "pi",
      skillBindings: {
        zeta: alphaVersion.id,
        alpha: betaVersion.id,
      },
    };
    const validInput = {
      revision: 1,
      config: validConfig,
      digest: await agentVersionDigest(validConfig),
    };
    const validKey = "valid-nonempty-bindings";
    let validBody: { config: unknown; digest: string };
    await test.step("valid non-empty bindings preserve config and resolve sorted exact pins", async () => {
      const response = await post(
        `/v1/agents/${agentId}/versions`,
        validInput,
        validKey,
      );
      assertEquals(response.status, 201, await response.clone().text());
      validBody = await response.json() as {
        config: unknown;
        digest: string;
      };
      assertEquals(validBody.config, validConfig);
      assertEquals(validBody.digest, await agentVersionDigest(validConfig));

      const pins = await withPgTransaction(
        fixture.runtimePgDatabase,
        (transaction) =>
          resolveAgentSkillBindings(
            transaction,
            organizationId,
            validConfig.skillBindings,
          ),
      );
      assertEquals(pins, [
        { versionId: betaVersion.id, digest: betaVersion.digest },
        { versionId: alphaVersion.id, digest: alphaVersion.digest },
      ]);

      const replay = await post(
        `/v1/agents/${agentId}/versions`,
        validInput,
        validKey,
      );
      assertEquals(replay.status, 201);
      assertEquals(await replay.json(), validBody);
    });

    await test.step("missing and foreign immutable IDs are non-enumerating", async () => {
      foreignOrganizationId = crypto.randomUUID();
      const foreignSourceId = crypto.randomUUID();
      const foreignSkillId = crypto.randomUUID();
      const foreignDigest = "f".repeat(64);
      const foreignVersionId = await deriveSkillVersionId({
        organizationId: foreignOrganizationId,
        skillId: foreignSkillId,
        revision: 1,
        digest: foreignDigest,
      });
      await fixture.pgDatabase.query(
        `insert into bakery.organizations (
           id, name, slug, metadata, created_at, updated_at, version
         ) values ($1, 'Foreign', $2, '{}'::jsonb, now(), now(), 1)`,
        [foreignOrganizationId, `foreign-${foreignOrganizationId}`],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.skill_sources
           (id, organization_id, source_type, locator, display_name)
         values ($1, $2, 'local_bundle', $3, 'Foreign source')`,
        [foreignSourceId, foreignOrganizationId, `local://${foreignSkillId}`],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.skills
           (id, organization_id, source_id, slug, name)
         values ($1, $2, $3, 'foreign-skill', 'Foreign skill')`,
        [foreignSkillId, foreignOrganizationId, foreignSourceId],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.skill_versions
           (id, organization_id, skill_id, revision, source_revision, digest,
            entry_path, manifest, status, created_by)
         values ($1, $2, $3, 1, 'foreign', $4, 'SKILL.md', '{}'::jsonb,
                 'published', $5)`,
        [
          foreignVersionId,
          foreignOrganizationId,
          foreignSkillId,
          foreignDigest,
          principalId,
        ],
      );
      const missingVersionId = await deriveSkillVersionId({
        organizationId,
        skillId: crypto.randomUUID(),
        revision: 1,
        digest: "e".repeat(64),
      });
      const foreign = await expectRejected(agentId, {
        harness: "pi",
        skillBindings: { main: foreignVersionId },
      }, "skill_binding_unavailable");
      const missing = await expectRejected(agentId, {
        harness: "pi",
        skillBindings: { main: missingVersionId },
      }, "skill_binding_unavailable");
      assertEquals(foreign.issues, missing.issues);
    });

    await test.step("invalid, duplicate, and over-limit bindings fail atomically", async () => {
      await expectRejected(agentId, {
        harness: "pi",
        skillBindings: { main: crypto.randomUUID() },
      }, "skill_binding_invalid");
      await expectRejected(agentId, {
        harness: "pi",
        skillBindings: { alpha: alphaVersion.id, beta: alphaVersion.id },
      }, "skill_binding_duplicate");
      await expectRejected(agentId, {
        harness: "pi",
        skillBindings: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [
            `binding-${index}`,
            index === 0 ? alphaVersion.id : crypto.randomUUID(),
          ]),
        ),
      }, "skill_bindings_too_many");
    });

    await test.step("unpublished and disabled catalog authority fail atomically", async () => {
      await fixture.pgDatabase.query(
        "update bakery.skill_versions set status = 'draft' where id = $1",
        [alphaVersion.id],
      );
      await expectRejected(agentId, {
        harness: "pi",
        skillBindings: { main: alphaVersion.id },
      }, "skill_binding_not_published");
      await fixture.pgDatabase.query(
        "update bakery.skill_versions set status = 'published' where id = $1",
        [alphaVersion.id],
      );

      await fixture.pgDatabase.query(
        "update bakery.skills set enabled = false where id = $1",
        [alpha.id],
      );
      const replay = await post(
        `/v1/agents/${agentId}/versions`,
        validInput,
        validKey,
      );
      assertEquals(replay.status, 201);
      assertEquals(await replay.json(), validBody!);
      await expectRejected(agentId, {
        harness: "pi",
        skillBindings: { main: alphaVersion.id },
      }, "skill_binding_revoked");
      await fixture.pgDatabase.query(
        "update bakery.skills set enabled = true where id = $1",
        [alpha.id],
      );

      const sourceConfig = {
        harness: "pi",
        skillBindings: { main: alphaVersion.id },
      };
      const beforeConcurrentDisable = await facts();
      let pendingAdmission: Promise<Response> | Response;
      await withPgTransaction(fixture.pgDatabase, async (transaction) => {
        await transaction.query(
          "update bakery.skill_sources set enabled = false where id = $1",
          [alpha.sourceId],
        );
        pendingAdmission = post(`/v1/agents/${agentId}/versions`, {
          revision: 2,
          config: sourceConfig,
          digest: await agentVersionDigest(sourceConfig),
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const concurrentResponse = await pendingAdmission!;
      const concurrentProblem = await concurrentResponse.json() as {
        issues?: Array<{ code: string }>;
      };
      assertEquals(concurrentResponse.status, 422);
      assertEquals(
        concurrentProblem.issues?.[0]?.code,
        "skill_binding_revoked",
      );
      assertEquals(await facts(), beforeConcurrentDisable);
      await fixture.pgDatabase.query(
        "update bakery.skill_sources set enabled = true where id = $1",
        [alpha.sourceId],
      );
    });

    await test.step("empty bindings remain valid and prompt guard remains closed", async () => {
      const empty = { harness: "pi", skillBindings: {} };
      const response = await post(`/v1/agents/${agentId}/versions`, {
        revision: 2,
        config: empty,
        digest: await agentVersionDigest(empty),
      });
      assertEquals(response.status, 201, await response.clone().text());

      const prompt = { harness: "pi", promptBindings: { main: "v1" } };
      const before = await facts();
      const rejected = await post(`/v1/agents/${agentId}/versions`, {
        revision: 3,
        config: prompt,
        digest: await agentVersionDigest(prompt),
      });
      const problem = await rejected.json() as {
        issues?: Array<{ code: string }>;
      };
      assertEquals(rejected.status, 422);
      assertEquals(problem.issues?.[0]?.code, "binding_source_unavailable");
      assertEquals(await facts(), before);
    });
  } finally {
    if (foreignOrganizationId) {
      await fixture.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [foreignOrganizationId],
      ).catch(() => undefined);
    }
    await context.close(true);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
