import { assertEquals } from "@std/assert";
import { collectArtifactVersion } from "../../../apps/server/src/modules/knowledge/retention/collector.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { signSessionCookie } from "../../helpers/auth.ts";
import type { Stack } from "./stack.ts";

/** What the live review spec needs beyond the single seeded read artifact. */
export type ReviewFixture = {
  reviewArtifactId: string;
  reviewVersion1Id: string;
  reviewVersion2Id: string;
  reviewVersion1Text: string;
  reviewVersion2Text: string;
  expiredTaskId: string;
  expiredArtifactId: string;
  expiredVersionId: string;
  expiredSha256: string;
  deniedSessionCookie: string;
  /** Own task and HTML artifact so no other spec's counts or versions move. */
  previewTaskId: string;
  previewArtifactId: string;
  previewVersionId: string;
  previewHeading: string;
};

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ).map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Seeds, through the owner connection, the data the live review spec drives:
 * a two-revision artifact on the existing task, a tombstoned version purged by
 * the retention collector itself (not a hand-set `purged_at`), and a Guest
 * principal in the same organization who holds no resource grant.
 */
export async function seedReviewFixtures(
  stack: Stack,
  scope: { principalId: string; organizationId: string },
  base: { taskId: string; conversationId: string; applicationId: string },
): Promise<ReviewFixture> {
  const textEncoder = new TextEncoder();
  const reviewVersion1Text = "Review revision one: the original draft.\n";
  const reviewVersion2Text = "Review revision two: the latest draft.\n";
  const expiredText = "Expired revision bytes that retention purges.\n";
  const deniedEmail = `e2e-artifact-denied-${crypto.randomUUID()}@example.test`;
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    // A signed-in Guest of the artifact's organization (the role that holds no
    // permission), seeded as the database owner with a live session.
    const providerUserId = crypto.randomUUID();
    const deniedPrincipal = crypto.randomUUID();
    const now = new Date();
    await database.query(
      `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, 'Artifact denied guest', $2, true, $3, $3)`,
      [providerUserId, deniedEmail, now],
    );
    await database.query(
      `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
       values ($1, $2, 'Artifact denied guest', 'human')`,
      [deniedPrincipal, providerUserId],
    );
    await database.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
       ) values ($1, $2, $3, 'guest', 'active', $4, $4, $4, 1)`,
      [crypto.randomUUID(), scope.organizationId, deniedPrincipal, now],
    );
    const token = `artifact-denied-${crypto.randomUUID()}`;
    await database.query(
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
    const deniedSessionCookie = await signSessionCookie(
      token,
      stack.authSecret,
    );

    const reviewArtifactId = crypto.randomUUID();
    const reviewVersion1Id = crypto.randomUUID();
    const reviewVersion2Id = crypto.randomUUID();
    await database.query(
      `insert into bakery.artifacts
         (id, organization_id, task_id, artifact_type, name, revision, version)
       values ($1, $2, $3, 'other', 'Live review artifact', 2, 1)`,
      [reviewArtifactId, scope.organizationId, base.taskId],
    );
    for (
      const [id, revision, text] of [
        [reviewVersion1Id, 1, reviewVersion1Text],
        [reviewVersion2Id, 2, reviewVersion2Text],
      ] as const
    ) {
      const content = textEncoder.encode(text);
      await database.query(
        `insert into bakery.artifact_versions
           (id, organization_id, artifact_id, task_id, run_step_id, revision,
            author_id, subject_head_sha, subject_base_sha, step_key, metadata,
            content, sha256, size_bytes, media_type)
         values ($1, $2, $3, $4, null, $5, $6, null, null, null, '{}'::jsonb,
                 $7, $8, $9, 'text/plain')`,
        [
          id,
          scope.organizationId,
          reviewArtifactId,
          base.taskId,
          revision,
          scope.principalId,
          content,
          await sha256(content),
          content.byteLength,
        ],
      );
    }
    await database.query(
      `update bakery.artifacts set current_version_id = $1
        where organization_id = $2 and id = $3`,
      [reviewVersion2Id, scope.organizationId, reviewArtifactId],
    );

    // A terminal task owns the artifact whose bytes retention purges.
    const expiredTaskId = crypto.randomUUID();
    const expiredArtifactId = crypto.randomUUID();
    const expiredVersionId = crypto.randomUUID();
    const expiredContent = textEncoder.encode(expiredText);
    const expiredSha256 = await sha256(expiredContent);
    await database.query(
      `insert into bakery.tasks
         (id, organization_id, application_id, conversation_id, title,
          description, task_type, status, created_by)
       values ($1, $2, $3, $4, 'Expired artifact task',
               'Terminal task whose artifact bytes retention purges.',
               'feature', 'queued', $5)`,
      [
        expiredTaskId,
        scope.organizationId,
        base.applicationId,
        base.conversationId,
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.artifacts
         (id, organization_id, task_id, artifact_type, name, revision, version)
       values ($1, $2, $3, 'other', 'Expired review artifact', 1, 1)`,
      [expiredArtifactId, scope.organizationId, expiredTaskId],
    );
    await database.query(
      `insert into bakery.artifact_versions
         (id, organization_id, artifact_id, task_id, run_step_id, revision,
          author_id, subject_head_sha, subject_base_sha, step_key, metadata,
          content, sha256, size_bytes, media_type, retention_class)
       values ($1, $2, $3, $4, null, 1, $5, null, null, null, '{}'::jsonb,
               $6, $7, $8, 'text/plain', 'transient')`,
      [
        expiredVersionId,
        scope.organizationId,
        expiredArtifactId,
        expiredTaskId,
        scope.principalId,
        expiredContent,
        expiredSha256,
        expiredContent.byteLength,
      ],
    );
    await database.query(
      `update bakery.artifacts set current_version_id = $1
        where organization_id = $2 and id = $3`,
      [expiredVersionId, scope.organizationId, expiredArtifactId],
    );
    await database.query(
      "update bakery.tasks set status = 'completed' where id = $1",
      [expiredTaskId],
    );
    await database.query(
      "update bakery.artifact_versions set expires_at = now() - interval '1 second' where id = $1",
      [expiredVersionId],
    );
    assertEquals(
      await collectArtifactVersion(database, expiredVersionId),
      true,
      "retention must purge the expired version",
    );
    const purged = await database.query<{ gone: boolean }>(
      "select (content is null and purged_at is not null) as gone from bakery.artifact_versions where id = $1",
      [expiredVersionId],
    );
    assertEquals(purged.rows[0]?.gone, true);
    // An HTML artifact whose inline script would change the title if it ran.
    const previewTaskId = crypto.randomUUID();
    const previewArtifactId = crypto.randomUUID();
    const previewVersionId = crypto.randomUUID();
    const previewHeading = "Preview isolation proof heading";
    const previewHtml = textEncoder.encode(
      `<!doctype html><html><head><meta charset="utf-8"><title>isolated preview</title></head>` +
        `<body><h1>${previewHeading}</h1>` +
        `<script>document.title = "script-ran";</script></body></html>`,
    );
    await database.query(
      `insert into bakery.tasks
         (id, organization_id, application_id, conversation_id, title,
          description, task_type, status, created_by)
       values ($1, $2, $3, $4, 'Preview artifact task',
               'Owns the HTML artifact the isolated preview spec renders.',
               'feature', 'queued', $5)`,
      [
        previewTaskId,
        scope.organizationId,
        base.applicationId,
        base.conversationId,
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.artifacts
         (id, organization_id, task_id, artifact_type, name, revision, version)
       values ($1, $2, $3, 'other', 'Preview HTML artifact', 1, 1)`,
      [previewArtifactId, scope.organizationId, previewTaskId],
    );
    await database.query(
      `insert into bakery.artifact_versions
         (id, organization_id, artifact_id, task_id, run_step_id, revision,
          author_id, subject_head_sha, subject_base_sha, step_key, metadata,
          content, sha256, size_bytes, media_type)
       values ($1, $2, $3, $4, null, 1, $5, null, null, null, '{}'::jsonb,
               $6, $7, $8, 'text/html')`,
      [
        previewVersionId,
        scope.organizationId,
        previewArtifactId,
        previewTaskId,
        scope.principalId,
        previewHtml,
        await sha256(previewHtml),
        previewHtml.byteLength,
      ],
    );
    await database.query(
      `update bakery.artifacts set current_version_id = $1
        where organization_id = $2 and id = $3`,
      [previewVersionId, scope.organizationId, previewArtifactId],
    );
    return {
      reviewArtifactId,
      reviewVersion1Id,
      reviewVersion2Id,
      reviewVersion1Text,
      reviewVersion2Text,
      expiredTaskId,
      expiredArtifactId,
      expiredVersionId,
      expiredSha256,
      deniedSessionCookie,
      previewTaskId,
      previewArtifactId,
      previewVersionId,
      previewHeading,
    };
  } finally {
    await closePgDatabase(database);
  }
}
