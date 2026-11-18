/**
 * Seeds the notification states the badge-state evidence needs.
 *
 *   deno run -A scripts/evidence/notification-badge-states/seed.ts <mode>
 *
 * Modes:
 *   base      one admin, nine notifications with real targets, six unread (B1)
 *   bulk      add unread rows until the count passes the 99 cap (B2)
 *   read-all  mark every row read, so the count is a true zero (B0)
 *
 * B3 (count unavailable) needs no seed: it is the count request failing, which
 * the capture produces at the network layer.
 *
 * The script is idempotent: `base` clears the recipient's rows first, so a
 * failed earlier run cannot leave rows behind and shift the count a still is
 * supposed to prove.
 *
 * Environment: the stack's `.env.<project>` (DATABASE_URL, BETTER_AUTH_SECRET,
 * and the rest of the server's auth environment). Source it first:
 *
 *   set -a; . ./.env.<project>; set +a
 */
import {
  readDatabaseConfig,
  readEnvironmentSnapshot,
  readRuntimeConfig,
} from "@bakery/config";
import {
  authEnvironmentNames,
  readAuthTaskEnvironment,
} from "../../../apps/server/src/platform/auth-task-config.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { createSuperuser } from "../../../apps/server/src/modules/auth/index.ts";

/** The unread count `bulk` leaves behind, past the badge's 99 cap. */
export const BULK_UNREAD = 120;

const EMAIL = "evidence@example.test";
const PASSWORD = "Evidence-Pass-1";
const DISPLAY = "Sam Lee";
const ACTOR = "Priya Raman";

const mode = Deno.args[0] ?? "base";

const databaseConfig = readDatabaseConfig(
  readEnvironmentSnapshot(["DATABASE_URL"]),
  "owner",
);
const authConfig = readRuntimeConfig(
  readAuthTaskEnvironment(
    readEnvironmentSnapshot(authEnvironmentNames),
    databaseConfig,
  ),
  "server",
).auth!;

const pg = openPgDatabase(databaseConfig.url);

async function q<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pg.query<T>(sql, values);
  return result.rows;
}

/** Creates the admin once; a second run finds it and does nothing. */
async function bootstrap() {
  const existing = await q<{ id: string }>(
    `select p.id from bakery.principals p
     join bakery.organization_memberships m on m.principal_id = p.id
     where p.display_name = $1 limit 1`,
    [DISPLAY],
  );
  if (existing.length > 0) return;
  await createSuperuser({ pgDatabase: pg, config: authConfig }, {
    email: EMAIL,
    displayName: DISPLAY,
    password: PASSWORD,
  });
}

async function recipient() {
  const rows = await q<{ principal_id: string; organization_id: string }>(
    `select p.id as principal_id, m.organization_id
     from bakery.principals p
     join bakery.organization_memberships m on m.principal_id = p.id
     where p.display_name = $1 limit 1`,
    [DISPLAY],
  );
  if (rows.length === 0) throw new Error("no seeded principal");
  return rows[0]!;
}

/**
 * The second human whose actions the inbox attributes. A principal's provider
 * id is a real provider user, so this makes one and keeps the membership
 * idempotent.
 */
async function actor(organizationId: string) {
  const found = await q<{ id: string }>(
    `select id from bakery.principals where display_name = $1 limit 1`,
    [ACTOR],
  );
  let id = found[0]?.id;
  if (id === undefined) {
    const user = await q<{ id: string }>(
      `insert into "user" (name, email, "emailVerified", "createdAt",
                           "updatedAt", "profile_version")
       values ($1, 'priya@example.test', false, now(), now(), 1)
       on conflict (email) do update set name = excluded.name
       returning id`,
      [ACTOR],
    );
    const created = await q<{ id: string }>(
      `insert into bakery.principals (provider_user_id, display_name,
                                      principal_type)
       values ($1, $2, 'human') returning id`,
      [user[0]!.id, ACTOR],
    );
    id = created[0]!.id;
  }
  const member = await q<{ id: string }>(
    `select id from bakery.organization_memberships
     where organization_id = $1 and principal_id = $2 limit 1`,
    [organizationId, id],
  );
  if (member.length === 0) {
    await q(
      `insert into bakery.organization_memberships
         (id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at, version)
       values (gen_random_uuid(), $1, $2, 'member', 'active', now(), now(),
               now(), 1)`,
      [organizationId, id],
    );
  }
  return id;
}

/** One application, conversation, task and run: the shared target. */
async function target(organizationId: string, createdBy: string) {
  const app = await q<{ id: string }>(
    `insert into bakery.applications (organization_id, slug, name, description)
     values ($1, 'evidence', 'Evidence', 'Seeded for visual evidence')
     on conflict do nothing returning id`,
    [organizationId],
  );
  const applicationId = app[0]?.id ?? (await q<{ id: string }>(
    `select id from bakery.applications
     where organization_id = $1 and slug = 'evidence'`,
    [organizationId],
  ))[0]!.id;

  const conversation = await q<{ id: string }>(
    `insert into bakery.conversations
       (organization_id, application_id, title, created_by)
     values ($1, $2, 'Rotate the staging certificates', $3) returning id`,
    [organizationId, applicationId, createdBy],
  );
  const conversationId = conversation[0]!.id;

  const task = await q<{ id: string }>(
    `insert into bakery.tasks
       (organization_id, application_id, conversation_id, title, description,
        task_type, status, priority, created_by, planning_only)
     values ($1, $2, $3, 'Rotate the staging certificates', 'Seeded task',
             'feature', 'completed', 0, $4, false) returning id`,
    [organizationId, applicationId, conversationId, createdBy],
  );
  const taskId = task[0]!.id;

  const run = await q<{ id: string }>(
    `insert into bakery.workflow_runs
       (organization_id, task_id, requested_by, status, snapshot,
        budget_limit_usd, engine_owner_generation, kind)
     values ($1, $2, $3, 'completed', '{}'::jsonb, 0, 0, 'task') returning id`,
    [organizationId, taskId, createdBy],
  );
  return { conversationId, taskId, runId: run[0]!.id };
}

/**
 * One domain event per notification, because the dedupe key includes the source
 * event. `sequence` is an identity column; `organization_sequence` is a plain
 * not-null column the writer supplies, so this keeps it monotonic per org.
 */
async function event(
  organizationId: string,
  taskId: string,
  conversationId: string,
) {
  const next = await q<{ next: string }>(
    `select coalesce(max(organization_sequence), 0) + 1 as next
     from bakery.domain_events where organization_id = $1`,
    [organizationId],
  );
  const version = await q<{ next: number }>(
    `select coalesce(max(aggregate_version), 0) + 1 as next
     from bakery.domain_events where organization_id = $1 and aggregate_id = $2`,
    [organizationId, taskId],
  );
  const rows = await q<{ id: string }>(
    `insert into bakery.domain_events
       (organization_id, event_type, schema_version, task_id, conversation_id,
        aggregate_id, aggregate_version, payload, organization_sequence)
     values ($1, 'notification.evidence', 1, $2, $3, $2, $4, '{}'::jsonb, $5)
     returning id`,
    [
      organizationId,
      taskId,
      conversationId,
      version[0]!.next,
      next[0]!.next,
    ],
  );
  return rows[0]!.id;
}

const KINDS = [
  "mention",
  "approval_requested",
  "run_completed",
  "comment",
  "run_failed",
  "question_asked",
  "document_version",
  "step_failed",
  "comment_mention",
] as const;

async function insertNotification(
  organizationId: string,
  recipientId: string,
  actorId: string,
  t: { conversationId: string; taskId: string; runId: string },
  kind: string,
  read: boolean,
  minutesAgo: number,
) {
  const sourceEventId = await event(organizationId, t.taskId, t.conversationId);
  await q(
    `insert into bakery.notifications
       (organization_id, recipient_id, kind, target_kind, target_id,
        target_anchor, conversation_id, run_id, task_id, actor_id,
        source_event_id, source_version, arguments, read_at, created_at)
     values ($1, $2, $3, 'run', $4, null, $5, $4, $6, $7, $8, 1,
             '{}'::jsonb, $9, now() - ($10 || ' minutes')::interval)`,
    [
      organizationId,
      recipientId,
      kind,
      t.runId,
      t.conversationId,
      t.taskId,
      actorId,
      sourceEventId,
      read ? new Date().toISOString() : null,
      String(minutesAgo),
    ],
  );
}

async function unreadCount(organizationId: string, recipientId: string) {
  const rows = await q<{ n: string }>(
    `select count(*)::text as n from bakery.notifications
     where organization_id = $1 and recipient_id = $2 and read_at is null`,
    [organizationId, recipientId],
  );
  return Number(rows[0]!.n);
}

await bootstrap();
const { principal_id: recipientId, organization_id: organizationId } =
  await recipient();
const actorId = await actor(organizationId);

if (mode === "base") {
  await q(
    `delete from bakery.notifications
     where organization_id = $1 and recipient_id = $2`,
    [organizationId, recipientId],
  );
  await q(
    `delete from bakery.domain_events
     where organization_id = $1 and event_type = 'notification.evidence'`,
    [organizationId],
  );
  const t = await target(organizationId, recipientId);
  // Six unread spread across today, yesterday and earlier, so the page groups
  // them; three read rows give the read state something to contrast with.
  const plan: [string, boolean, number][] = [
    ["mention", false, 19],
    ["approval_requested", false, 40],
    ["run_completed", false, 60],
    ["comment", false, 120],
    ["run_failed", false, 180],
    ["question_asked", false, 300],
    ["document_version", true, 420],
    ["step_failed", true, 1500],
    ["comment_mention", true, 1600],
  ];
  for (const [kind, read, minutes] of plan) {
    await insertNotification(
      organizationId,
      recipientId,
      actorId,
      t,
      kind,
      read,
      minutes,
    );
  }
} else if (mode === "bulk") {
  const t = (await q<
    { conversation_id: string; task_id: string; run_id: string }
  >(
    `select conversation_id, task_id, run_id from bakery.notifications
     where organization_id = $1 and recipient_id = $2 limit 1`,
    [organizationId, recipientId],
  ))[0];
  if (t === undefined) throw new Error("run `base` before `bulk`");
  const have = await unreadCount(organizationId, recipientId);
  for (let i = have; i < BULK_UNREAD; i += 1) {
    await insertNotification(
      organizationId,
      recipientId,
      actorId,
      {
        conversationId: t.conversation_id,
        taskId: t.task_id,
        runId: t.run_id,
      },
      KINDS[i % KINDS.length]!,
      false,
      i + 1,
    );
  }
} else if (mode === "read-all") {
  await q(
    `update bakery.notifications set read_at = now(), revision = revision + 1
     where organization_id = $1 and recipient_id = $2 and read_at is null`,
    [organizationId, recipientId],
  );
} else {
  throw new Error(`unknown mode ${mode}`);
}

console.log(
  `seeded ${mode}: unread=${await unreadCount(organizationId, recipientId)}`,
);
await closePgDatabase(pg);
