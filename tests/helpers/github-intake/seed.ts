import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import type {
  GitHubAppFixture,
  ResourceRow,
} from "../github-app-registration.ts";

/** How a seeded Bakery repository spells its `provider_repo_id`. */
export type ProviderRepoSpelling = "external-id" | "full-name";

export type SeedOptions = {
  /** Spelling of the tracked repository's `provider_repo_id`; default the numeric id. */
  providerRepoId?: ProviderRepoSpelling;
  /** Archives the tracked repository, so the join must not use it. */
  archived?: boolean;
  /**
   * Adds a second repository on the same connection that claims the other
   * spelling of the same GitHub repository, so the join is ambiguous.
   * (`provider_repo_id` is unique per connection, so a second row cannot
   * repeat the first row's spelling.)
   */
  competing?: boolean;
};

export type SeededTask = {
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  taskId: string;
  conversationId: string;
  /** The second repository `competing: true` adds, else null. */
  competingRepositoryId: string | null;
};

/**
 * Inserts the minimal application, Bakery repository, conversation and task
 * a pull request row needs, as the database owner, in the organization of
 * `resource`. The repository is bound to the resource's connection and its
 * `provider_repo_id` is the resource's numeric id (or its full name).
 * Follows the coordination fixture's repository insert and the task insert
 * of the work module; the author of both is the fixture Admin.
 */
export async function seedTaskAndRepository(
  fixture: Pick<GitHubAppFixture, "pgDatabase" | "adminId">,
  resource: Pick<
    ResourceRow,
    "organization_id" | "connection_id" | "external_id" | "display_name"
  >,
  options: SeedOptions = {},
): Promise<SeededTask> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const organizationId = resource.organization_id;
  const [owner, name] = resource.display_name.split("/");
  const spelling = options.providerRepoId ?? "external-id";
  const spellings: Record<ProviderRepoSpelling, string> = {
    "external-id": resource.external_id,
    "full-name": resource.display_name,
  };
  const seeded: SeededTask = {
    organizationId,
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    competingRepositoryId: options.competing ? crypto.randomUUID() : null,
  };
  await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    await transaction.query(
      `insert into bakery.applications (id, organization_id, slug, name, description)
       values ($1, $2, $3, 'Intake seed', '')`,
      [seeded.applicationId, organizationId, `intake-seed-${suffix}`],
    );
    const repository = async (
      id: string,
      providerRepoId: string,
      repositoryName: string,
      archived: boolean,
    ) => {
      await transaction.query(
        `insert into bakery.repositories (
           id, organization_id, application_id, integration_connection_id,
           provider_repo_id, owner, name, default_branch, archived_at, version
         ) values ($1, $2, $3, $4, $5, $6, $7, 'main',
           case when $8::boolean then now() end, 1)`,
        [
          id,
          organizationId,
          seeded.applicationId,
          resource.connection_id,
          providerRepoId,
          owner,
          repositoryName,
          archived,
        ],
      );
    };
    await repository(
      seeded.repositoryId,
      spellings[spelling],
      name,
      options.archived === true,
    );
    if (seeded.competingRepositoryId !== null) {
      await repository(
        seeded.competingRepositoryId,
        spellings[spelling === "external-id" ? "full-name" : "external-id"],
        `${name}-competing`,
        false,
      );
    }
    await transaction.query(
      `insert into bakery.conversations (
         id, organization_id, application_id, repository_id, title, created_by
       ) values ($1, $2, $3, $4, 'Intake seed', $5)`,
      [
        seeded.conversationId,
        organizationId,
        seeded.applicationId,
        seeded.repositoryId,
        fixture.adminId,
      ],
    );
    await transaction.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, repository_id, conversation_id,
         title, task_type, created_by
       ) values ($1, $2, $3, $4, $5, 'Intake seed', 'feature', $6)`,
      [
        seeded.taskId,
        organizationId,
        seeded.applicationId,
        seeded.repositoryId,
        seeded.conversationId,
        fixture.adminId,
      ],
    );
  });
  return seeded;
}

/**
 * Deletes everything `seedTaskAndRepository` inserted, children first: the
 * pull requests that name the task or repositories (their references are NO
 * ACTION), the task, the conversation, the repositories, the application.
 * Safe to call twice and after a partial seed, so a test runs it in `finally`.
 */
export async function removeSeed(
  fixture: Pick<GitHubAppFixture, "pgDatabase">,
  seeded: SeededTask,
): Promise<void> {
  const repositories = [seeded.repositoryId];
  if (seeded.competingRepositoryId !== null) {
    repositories.push(seeded.competingRepositoryId);
  }
  await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    const scope = [seeded.organizationId];
    // Ticket rows name the task, the repositories and the application without
    // a cascade: requests and links of the task, then the tickets, reports and
    // requests of every source on those repositories or that application.
    const sources = `select id from bakery.ticket_sources
      where organization_id = $1
        and (application_id = $2 or repository_id = any($3::uuid[]))`;
    const tickets = `select id from bakery.external_tickets
      where organization_id = $1 and ticket_source_id in (${sources})`;
    const sourceScope = [...scope, seeded.applicationId, repositories];
    await transaction.query(
      `delete from bakery.ticket_requests
        where organization_id = $1
          and (ticket_task_link_id in (
                 select id from bakery.ticket_task_links
                  where organization_id = $1 and task_id = $4)
            or external_ticket_id in (${tickets}))`,
      [...sourceScope, seeded.taskId],
    );
    await transaction.query(
      `delete from bakery.ticket_task_links
        where organization_id = $1
          and (task_id = $4 or external_ticket_id in (${tickets}))`,
      [...sourceScope, seeded.taskId],
    );
    await transaction.query(
      `delete from bakery.ticket_readiness_reports
        where organization_id = $1 and external_ticket_id in (${tickets})`,
      sourceScope,
    );
    await transaction.query(
      `delete from bakery.external_tickets
        where organization_id = $1 and ticket_source_id in (${sources})`,
      sourceScope,
    );
    await transaction.query(
      `delete from bakery.ticket_sources
        where organization_id = $1
          and (application_id = $2 or repository_id = any($3::uuid[]))`,
      sourceScope,
    );
    await transaction.query(
      `delete from bakery.pull_requests
        where organization_id = $1 and (task_id = $2 or repository_id = any($3::uuid[]))`,
      [...scope, seeded.taskId, repositories],
    );
    await transaction.query(
      "delete from bakery.tasks where organization_id = $1 and id = $2",
      [...scope, seeded.taskId],
    );
    await transaction.query(
      "delete from bakery.conversations where organization_id = $1 and id = $2",
      [...scope, seeded.conversationId],
    );
    await transaction.query(
      "delete from bakery.repositories where organization_id = $1 and id = any($2::uuid[])",
      [...scope, repositories],
    );
    await transaction.query(
      "delete from bakery.applications where organization_id = $1 and id = $2",
      [...scope, seeded.applicationId],
    );
  });
}

/** Seeds, runs `work`, and removes the seed whatever `work` does. */
export async function withSeededTask<T>(
  fixture: Pick<GitHubAppFixture, "pgDatabase" | "adminId">,
  resource: Parameters<typeof seedTaskAndRepository>[1],
  options: SeedOptions,
  work: (seeded: SeededTask) => Promise<T>,
): Promise<T> {
  const seeded = await seedTaskAndRepository(fixture, resource, options);
  try {
    return await work(seeded);
  } finally {
    await removeSeed(fixture, seeded);
  }
}
