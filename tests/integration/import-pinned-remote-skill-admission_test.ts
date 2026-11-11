import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { rearmStaleSkillImports } from "../../apps/server/src/modules/catalog/import-persistence.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  authRequest,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";

Deno.test("Admin API admits one PostgreSQL-backed pinned import Run", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `skill-import-${suffix}@example.test`;
  const password = `SkillImport-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill Import Admin", password });
    const scope = await fixture.pgDatabase.query<{
      organizationId: string;
    }>(
      `select organization_id as "organizationId"
         from bakery.organization_memberships as membership
         join public."user" as provider_user
           on provider_user.id = (
             select provider_user_id from bakery.principals
              where id = membership.principal_id
           )
        where provider_user.email = $1`,
      [email],
    );
    const organizationId = scope.rows[0]?.organizationId;
    if (!organizationId) throw new Error("TEST_ORGANIZATION_MISSING");
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const headers = {
      cookie,
      "Bakery-Organization-Id": organizationId,
      "Idempotency-Key": `source-${suffix}`,
    };
    const sourceResponse = await fixture.app.fetch(authRequest(
      "/v1/skill-sources",
      {
        sourceType: "git",
        url: "https://github.com/example/skills.git",
        name: "Example skills",
        license: "MIT",
      },
      { cookie, headers },
    ));
    assertEquals(
      sourceResponse.status,
      201,
      await sourceResponse.clone().text(),
    );
    const source = await sourceResponse.json() as { id: string };
    const importInput = {
      sourceId: source.id,
      revision: "v1.2.3",
      path: "skills/demo",
    };
    const admit = () =>
      fixture.app.fetch(authRequest(
        "/v1/skill-imports",
        importInput,
        {
          cookie,
          headers: {
            "Bakery-Organization-Id": organizationId,
            "Idempotency-Key": `import-${crypto.randomUUID()}`,
          },
        },
      ));
    const first = await admit();
    assertEquals(first.status, 201, await first.clone().text());
    const run = await first.json() as Record<string, unknown>;
    assertEquals(run.kind, "skill_import");
    assertEquals(run.taskId, null);
    assertEquals(run.workflowVersionId, null);
    assertEquals(run.skillSourceId, source.id);
    assertEquals(run.status, "queued");

    const replay = await admit();
    assertEquals(replay.status, 201, await replay.clone().text());
    const replayRun = await replay.json() as Record<string, unknown>;
    assertEquals(replayRun.id, run.id);
    assertEquals(replayRun.skillSourceId, source.id);

    const persisted = await fixture.pgDatabase.query<{
      runKind: string;
      checkpointCount: string;
      eventCount: string;
    }>(
      `select run.kind as "runKind",
              (select count(*)::text from bakery.skill_imports where run_id = run.id) as "checkpointCount",
              (select count(*)::text from bakery.outbox where event_id in (
                select id from bakery.domain_events where aggregate_id = run.id
              )) as "eventCount"
         from bakery.workflow_runs as run
        where run.organization_id = $1 and run.id = $2`,
      [organizationId, run.id],
    );
    assertEquals(persisted.rows[0], {
      runKind: "skill_import",
      checkpointCount: "1",
      eventCount: "1",
    });

    await fixture.pgDatabase.query(
      `update bakery.skill_imports
          set updated_at = now() - interval '10 minutes'
        where organization_id = $1 and run_id = $2`,
      [organizationId, run.id],
    );
    const rearmed = await withPgTransaction(
      fixture.runtimePgDatabase,
      (transaction) => rearmStaleSkillImports(transaction, 10, 60_000),
    );
    assertEquals(rearmed, [{ runId: run.id, generation: 1 }]);
    const recovery = await fixture.pgDatabase.query<{
      generation: string;
      eventCount: string;
      deliveryKey: string;
    }>(
      `select import.recovery_generation as generation,
              (select count(*)::text from bakery.domain_events
                where aggregate_id = import.run_id
                  and event_type = 'skill.import.requested') as "eventCount",
              (select delivery_key from bakery.outbox as outbox
                join bakery.domain_events as event on event.id = outbox.event_id
               where event.aggregate_id = import.run_id
               order by outbox.created_at desc limit 1) as "deliveryKey"
         from bakery.skill_imports as import
        where import.organization_id = $1 and import.run_id = $2`,
      [organizationId, run.id],
    );
    assertEquals(recovery.rows[0], {
      generation: "1",
      eventCount: "2",
      deliveryKey: `skill-import:${run.id}:generation:1`,
    });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
  }
});
