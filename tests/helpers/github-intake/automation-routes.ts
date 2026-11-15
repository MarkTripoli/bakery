import type { GitHubAppFixture } from "../github-app-registration.ts";
import type { SeededTask } from "./seed.ts";

// Automations bound to a seeded repository, for the event-trigger tests (#36
// slice 4d): a published workflow version to point at, a definition, and as many
// versions as a test needs.

type Fixture = Pick<GitHubAppFixture, "pgDatabase" | "adminId">;

export type SeededAutomation = {
  definitionId: string;
  versionId: string;
  workflowVersionId: string;
};

export type AutomationOptions = {
  trigger: Record<string, unknown>;
  overlapPolicy?: "skip" | "queue_one";
  enabled?: boolean;
  /** Bound to this repository; the task's by default. */
  repositoryId?: string;
};

const workflowVersions = new Map<string, string>();

/** One published workflow version per organization, made on first use. */
async function workflowVersionOf(
  f: Fixture,
  organizationId: string,
): Promise<string> {
  const known = workflowVersions.get(organizationId);
  if (known !== undefined) return known;
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
     values ($1, $2, $3, 'Event automation target', true, 1)`,
    [workflowId, organizationId, `event-target-${workflowId}`],
  );
  await f.pgDatabase.query(
    `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision,
       source_yaml, normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, '', '{}'::jsonb, $4, 'published', $5)`,
    [versionId, organizationId, workflowId, `digest-${versionId}`, f.adminId],
  );
  workflowVersions.set(organizationId, versionId);
  return versionId;
}

/** Adds a version to an automation, optionally making it the active one. */
export async function addAutomationVersion(
  f: Fixture,
  task: Pick<SeededTask, "organizationId" | "applicationId" | "repositoryId">,
  definitionId: string,
  options: AutomationOptions & { revision: number; activate: boolean },
): Promise<string> {
  const workflowVersionId = await workflowVersionOf(f, task.organizationId);
  const versionId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.automation_versions (
       id, organization_id, automation_id, revision, trigger, workflow_version_id,
       actor_id, inputs, misfire_policy, overlap_policy, digest, application_id,
       repository_id, budget_limit_usd
     ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, '{}'::jsonb, 'coalesce', $8, $9,
       $10, $11, 1)`,
    [
      versionId,
      task.organizationId,
      definitionId,
      options.revision,
      JSON.stringify(options.trigger),
      workflowVersionId,
      f.adminId,
      options.overlapPolicy ?? "skip",
      `digest-${versionId}`,
      task.applicationId,
      options.repositoryId ?? task.repositoryId,
    ],
  );
  if (options.activate) {
    await f.pgDatabase.query(
      `update bakery.automation_definitions set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [task.organizationId, definitionId, versionId],
    );
  }
  return versionId;
}

/** An automation with one active version bound to the task's repository. */
export async function seedAutomation(
  f: Fixture,
  task: Pick<SeededTask, "organizationId" | "applicationId" | "repositoryId">,
  options: AutomationOptions,
): Promise<SeededAutomation> {
  const definitionId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.automation_definitions (id, organization_id, slug, name, enabled)
     values ($1, $2, $3, 'Event automation', $4)`,
    [
      definitionId,
      task.organizationId,
      `event-automation-${definitionId}`,
      options.enabled ?? true,
    ],
  );
  const versionId = await addAutomationVersion(f, task, definitionId, {
    ...options,
    revision: 1,
    activate: true,
  });
  return {
    definitionId,
    versionId,
    workflowVersionId: await workflowVersionOf(f, task.organizationId),
  };
}

export type FiringRow = {
  id: string;
  automationId: string;
  versionId: string;
  status: string;
  pending: boolean;
  skippedCount: number;
  triggerEventId: string | null;
  scheduledAt: Date;
};

/** Every firing of the organization, oldest instant first. */
export async function firingRows(
  f: Pick<GitHubAppFixture, "pgDatabase">,
  organizationId: string,
): Promise<FiringRow[]> {
  return (await f.pgDatabase.query<FiringRow>(
    `select firing.id, version.automation_id as "automationId",
            firing.automation_version_id as "versionId", firing.status,
            firing.pending, firing.skipped_count as "skippedCount",
            firing.trigger_event_id as "triggerEventId",
            firing.scheduled_at as "scheduledAt"
       from bakery.automation_firings firing
       join bakery.automation_versions version
         on version.organization_id = firing.organization_id
        and version.id = firing.automation_version_id
      where firing.organization_id = $1
      order by firing.scheduled_at, firing.id`,
    [organizationId],
  )).rows;
}
