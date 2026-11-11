import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";

/**
 * Database-owner helper for `apps/web/tests/run-observation-real-harness.spec.ts`
 * (FS06, issue #420). Everything it writes is labeled "DB-seeded": the rows are
 * inserted directly, then served and rendered through the real routes, so the
 * spec proves the browser and server handling of hostile or oversized bytes
 * and not worker publication. It never touches the task the real run uses.
 *
 * Subcommands (one JSON line on stdout; secrets never printed):
 * - `seed <ownerEmail>`: a separate seed task with a completed run and step,
 *   a 1.5 MiB `text/x-diff` patch bound to that step, a 9 MiB binary artifact
 *   and a `text/html` artifact whose bytes contain a script.
 * - `outsider <ownerEmail> <outsiderEmail>`: a second user in its own
 *   organization with a signed session cookie (needs `BETTER_AUTH_SECRET`).
 * - `digests <ownerEmail> <versionId>...`: the stored digest, the digest the
 *   database computes over the stored bytes, and the stored length.
 * - `scope <ownerEmail>`: the owner's organization and principal ids.
 * - `head <ownerEmail> <attemptId>`: the `headSha` the attempt's result
 *   recorded, which no API projection exposes.
 *
 * Config is the stack's owner `DATABASE_URL`, like `web-member-seed.ts`.
 */

const PATCH_BYTES = 1_572_864; // 1.5 MiB, over the 1 MiB inline diff limit.
const CARD_BYTES = 9_437_184; // 9 MiB, over the 8 MiB card download cap.
export const HOSTILE_HTML = "<script>window.__fs06=1</script>\n";

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
    ),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signSessionCookie(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${token}.${btoa(binary)}`;
}

async function ownerScope(database: PgDatabase, email: string) {
  const scope = (await database.query<
    { principalId: string; organizationId: string }
  >(
    `select principal.id as "principalId", membership.organization_id as "organizationId"
       from bakery.principals principal
       join public."user" provider_user on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships membership on membership.principal_id = principal.id
      where provider_user.email = $1`,
    [email.trim().toLowerCase()],
  )).rows[0];
  if (!scope) throw new Error("RUN_ARTIFACT_SEED_SCOPE_REQUIRED");
  return scope;
}

/** A diff of `lines` added lines, padded to exactly `size` bytes of ASCII. */
function oversizedPatch(size: number): Uint8Array {
  const head = "diff --git a/big.txt b/big.txt\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1 @@\n+";
  const bytes = new Uint8Array(size).fill(0x78);
  const prefix = new TextEncoder().encode(head);
  bytes.set(prefix);
  bytes[size - 1] = 0x0a;
  return bytes;
}

async function seed(database: PgDatabase, email: string) {
  const scope = await ownerScope(database, email);
  const ids = {
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
  };
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const patch = oversizedPatch(PATCH_BYTES);
  const card = new Uint8Array(CARD_BYTES);
  for (let index = 0; index < card.length; index += 1) {
    card[index] = (index * 31 + 7) & 0xff;
  }
  const html = new TextEncoder().encode(HOSTILE_HTML);
  const inserted: Record<string, {
    artifactId: string;
    versionId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    name: string;
  }> = {};
  await withPgTransaction(database, async (transaction) => {
    await transaction.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'FS06 seeded artifacts')`,
      [
        ids.applicationId,
        scope.organizationId,
        `fs06-seed-${ids.applicationId}`,
      ],
    );
    await transaction.query(
      `insert into bakery.conversations (id, organization_id, application_id, title, created_by)
       values ($1, $2, $3, 'FS06 seeded artifacts', $4)`,
      [
        ids.conversationId,
        scope.organizationId,
        ids.applicationId,
        scope.principalId,
      ],
    );
    await transaction.query(
      `insert into bakery.tasks
         (id, organization_id, application_id, conversation_id, title, description, task_type, status, created_by)
       values ($1, $2, $3, $4, 'FS06 seeded hostile artifacts',
               'DB-seeded: oversized and hostile bytes served through the real content route', 'feature', 'queued', $5)`,
      [
        ids.taskId,
        scope.organizationId,
        ids.applicationId,
        ids.conversationId,
        scope.principalId,
      ],
    );
    await transaction.query(
      `insert into bakery.workflow_definitions (id, organization_id, slug, name)
       values ($1, $2, $3, 'FS06 seeded workflow')`,
      [ids.workflowId, scope.organizationId, `fs06-seed-${ids.workflowId}`],
    );
    await transaction.query(
      `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision,
         source_yaml, normalized_spec, digest, status, created_by)
       values ($1, $2, $3, 1, 'name: fs06-seed', '{"name":"fs06-seed"}', $4, 'published', $5)`,
      [
        ids.versionId,
        scope.organizationId,
        ids.workflowId,
        `fs06-seed-${ids.versionId}`,
        scope.principalId,
      ],
    );
    await transaction.query(
      `insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id,
         requested_by, status, snapshot, budget_limit_usd)
       values ($1, $2, $3, $4, $5, 'completed', '{"name":"fs06-seed"}', 0)`,
      [
        ids.runId,
        scope.organizationId,
        ids.taskId,
        ids.versionId,
        scope.principalId,
      ],
    );
    await transaction.query(
      `insert into bakery.run_steps (id, organization_id, run_id, step_key, position, iteration,
         status, input)
       values ($1, $2, $3, 'implement', 1, 0, 'completed', '{}')`,
      [ids.stepId, scope.organizationId, ids.runId],
    );
    await transaction.query(
      `update bakery.tasks set current_run_id = $2 where organization_id = $1 and id = $3`,
      [scope.organizationId, ids.runId, ids.taskId],
    );
    const publish = async (
      key: string,
      artifactType: string,
      name: string,
      mediaType: string,
      content: Uint8Array,
      bound: { readonly head: string | null; readonly base: string | null },
    ) => {
      const artifactId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const digest = await sha256(content);
      await transaction.query(
        `insert into bakery.artifacts
           (id, organization_id, task_id, artifact_type, name, revision, version)
         values ($1, $2, $3, $4, $5, 1, 1)`,
        [artifactId, scope.organizationId, ids.taskId, artifactType, name],
      );
      await transaction.query(
        `insert into bakery.artifact_versions
           (id, organization_id, artifact_id, task_id, run_step_id, revision, author_id,
            subject_head_sha, subject_base_sha, step_key, metadata, content, sha256,
            size_bytes, media_type, retention_class, expires_at)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8, 'implement',
                 '{"seeded":"fs06-db-seeded"}'::jsonb, $9, $10, $11, $12,
                 'evidence', now() + interval '30 days')`,
        [
          versionId,
          scope.organizationId,
          artifactId,
          ids.taskId,
          ids.stepId,
          scope.principalId,
          bound.head,
          bound.base,
          content,
          digest,
          content.byteLength,
          mediaType,
        ],
      );
      await transaction.query(
        `update bakery.artifacts set current_version_id = $1
          where organization_id = $2 and id = $3`,
        [versionId, scope.organizationId, artifactId],
      );
      inserted[key] = {
        artifactId,
        versionId,
        sha256: digest,
        sizeBytes: content.byteLength,
        mediaType,
        name,
      };
    };
    await publish(
      "patch",
      "patch",
      "fs06-seeded-oversized.patch",
      "text/x-diff",
      patch,
      { head: headSha, base: baseSha },
    );
    await publish(
      "card",
      "other",
      "fs06-seeded-nine-mebibytes.bin",
      "application/octet-stream",
      card,
      { head: null, base: null },
    );
    await publish(
      "html",
      "other",
      "fs06-seeded-hostile.html",
      "text/html",
      html,
      { head: null, base: null },
    );
  });
  return {
    label: "DB-seeded, served through the real content route",
    organizationId: scope.organizationId,
    ...ids,
    baseSha,
    headSha,
    artifacts: inserted,
  };
}

async function outsider(
  database: PgDatabase,
  ownerEmail: string,
  outsiderEmail: string,
) {
  const secret = Deno.env.get("BETTER_AUTH_SECRET");
  if (!secret) throw new Error("RUN_ARTIFACT_SEED_AUTH_SECRET_REQUIRED");
  const owner = await ownerScope(database, ownerEmail);
  const email = outsiderEmail.trim().toLowerCase();
  const now = new Date();
  const token = `fs06-outsider-${crypto.randomUUID()}`;
  let organizationId: string = crypto.randomUUID();
  await withPgTransaction(database, async (transaction) => {
    // Idempotent: a second run reuses the outsider and its own organization
    // and only mints a fresh session.
    const existing = (await transaction.query<
      { userId: string; organizationId: string | null }
    >(
      `select provider_user.id as "userId", membership.organization_id as "organizationId"
         from public."user" provider_user
         left join bakery.principals principal on principal.provider_user_id = provider_user.id
         left join bakery.organization_memberships membership on membership.principal_id = principal.id
        where provider_user.email = $1`,
      [email],
    )).rows[0];
    const userId = existing?.userId ?? crypto.randomUUID();
    if (existing) {
      if (!existing.organizationId) {
        throw new Error("RUN_ARTIFACT_SEED_OUTSIDER_WITHOUT_ORGANIZATION");
      }
      organizationId = existing.organizationId;
    } else {
      const principalId = crypto.randomUUID();
      await transaction.query(
        `insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, 'FS06 outsider', $2, true, $3, $3)`,
        [userId, email, now],
      );
      await transaction.query(
        `insert into bakery.principals (id, provider_user_id, display_name, principal_type)
         values ($1, $2, 'FS06 outsider', 'human')`,
        [principalId, userId],
      );
      await transaction.query(
        `insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
         values ($1, 'FS06 outsider organization', $2, '{}'::jsonb, $3, $3, 1)`,
        [organizationId, `fs06-outsider-${organizationId}`, now],
      );
      await transaction.query(
        `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
         ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
        [crypto.randomUUID(), organizationId, principalId, now],
      );
    }
    await transaction.query(
      `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        token,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
  });
  return {
    ownerOrganizationId: owner.organizationId,
    outsiderOrganizationId: organizationId,
    cookieName: "better-auth.session_token",
    cookieValue: await signSessionCookie(token, secret),
  };
}

async function digests(
  database: PgDatabase,
  ownerEmail: string,
  versionIds: readonly string[],
) {
  const scope = await ownerScope(database, ownerEmail);
  const rows = (await database.query<{
    id: string;
    storedSha256: string;
    computedSha256: string | null;
    storedSizeBytes: number;
    computedSizeBytes: number | null;
  }>(
    `select id, sha256 as "storedSha256",
            encode(sha256(content), 'hex') as "computedSha256",
            size_bytes as "storedSizeBytes",
            octet_length(content) as "computedSizeBytes"
       from bakery.artifact_versions
      where organization_id = $1 and id = any($2::uuid[])`,
    [scope.organizationId, versionIds],
  )).rows;
  return { organizationId: scope.organizationId, versions: rows };
}

async function head(
  database: PgDatabase,
  ownerEmail: string,
  attemptId: string,
) {
  const scope = await ownerScope(database, ownerEmail);
  const row = (await database.query<
    { headSha: string | null; baseSha: string | null }
  >(
    `select coalesce(result->'result'->>'headSha', result->>'headSha') as "headSha",
            coalesce(result->'result'->>'baseSha', result->>'baseSha') as "baseSha"
       from bakery.job_attempts
      where organization_id = $1 and id = $2`,
    [scope.organizationId, attemptId],
  )).rows[0];
  return {
    attemptId,
    headSha: row?.headSha ?? null,
    baseSha: row?.baseSha ?? null,
  };
}

if (import.meta.main) {
  const [command, ...args] = Deno.args;
  const database = openPgDatabase(
    readDatabaseConfig(Deno.env.toObject(), "owner").url,
  );
  try {
    const result = command === "seed" && args[0]
      ? await seed(database, args[0])
      : command === "outsider" && args[0] && args[1]
      ? await outsider(database, args[0], args[1])
      : command === "digests" && args[0] && args.length > 1
      ? await digests(database, args[0], args.slice(1))
      : command === "scope" && args[0]
      ? await ownerScope(database, args[0])
      : command === "head" && args[0] && args[1]
      ? await head(database, args[0], args[1])
      : null;
    if (result === null) {
      console.error(
        "web-run-artifact-seed: usage: seed <ownerEmail> | outsider <ownerEmail> <outsiderEmail> | digests <ownerEmail> <versionId>... | scope <ownerEmail> | head <ownerEmail> <attemptId>",
      );
      Deno.exit(2);
    }
    console.log(JSON.stringify(result));
  } finally {
    await closePgDatabase(database);
  }
}
