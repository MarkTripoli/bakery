import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";

export async function seedBrowserArtifact(email: string) {
  const database = openPgDatabase(
    readDatabaseConfig(Deno.env.toObject(), "owner").url,
  );
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const text = "seeded/read proof only\nbounded immutable browser bytes\n";
  const content = new TextEncoder().encode(text);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    const scopes = await database.query<
      { readonly principalId: string; readonly organizationId: string }
    >(
      `select principal.id as "principalId", membership.organization_id as "organizationId"
         from bakery.principals principal
         join public."user" provider_user on provider_user.id = principal.provider_user_id
         join bakery.organization_memberships membership on membership.principal_id = principal.id
        where provider_user.email = $1`,
      [email],
    );
    const scope = scopes.rows[0];
    if (!scope) throw new Error("BROWSER_ARTIFACT_SCOPE_REQUIRED");
    await withPgTransaction(database, async (transaction) => {
      await transaction.query(
        `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Browser core fixture')`,
        [applicationId, scope.organizationId, `browser-${applicationId}`],
      );
      await transaction.query(
        `insert into bakery.conversations (id, organization_id, application_id, title, created_by)
       values ($1, $2, $3, 'Browser core fixture', $4)`,
        [
          conversationId,
          scope.organizationId,
          applicationId,
          scope.principalId,
        ],
      );
      await transaction.query(
        `insert into bakery.tasks
       (id, organization_id, application_id, conversation_id, title, description, task_type, status, created_by)
       values ($1, $2, $3, $4, 'Browser core fixture', 'Seeded read proof only', 'feature', 'queued', $5)`,
        [
          taskId,
          scope.organizationId,
          applicationId,
          conversationId,
          scope.principalId,
        ],
      );
      await transaction.query(
        `insert into bakery.artifacts
       (id, organization_id, task_id, artifact_type, name, revision, version)
       values ($1, $2, $3, 'other', 'Browser core bytes', 1, 1)`,
        [artifactId, scope.organizationId, taskId],
      );
      await transaction.query(
        `insert into bakery.artifact_versions
       (id, organization_id, artifact_id, task_id, run_step_id, revision, author_id,
        subject_head_sha, subject_base_sha, step_key, metadata, content, sha256, size_bytes, media_type)
       values ($1, $2, $3, $4, null, 1, $5, null, null, null,
        '{"fixture":"seeded/read proof only","resultKind":"not-a-coding-result"}'::jsonb,
        $6, $7, $8, 'text/plain')`,
        [
          versionId,
          scope.organizationId,
          artifactId,
          taskId,
          scope.principalId,
          content,
          digest,
          content.byteLength,
        ],
      );
      await transaction.query(
        `update bakery.artifacts set current_version_id = $1 where organization_id = $2 and id = $3`,
        [versionId, scope.organizationId, artifactId],
      );
    });
    return {
      organizationId: scope.organizationId,
      taskId,
      artifactId,
      versionId,
      digest,
      text,
    };
  } finally {
    await closePgDatabase(database);
  }
}

if (import.meta.main) {
  const email = Deno.args[0];
  if (!email || Deno.env.get("BAKERY_ENV") !== "test") {
    throw new Error("ISOLATED_BROWSER_TEST_ENV_REQUIRED");
  }
  console.log(JSON.stringify(await seedBrowserArtifact(email)));
}
