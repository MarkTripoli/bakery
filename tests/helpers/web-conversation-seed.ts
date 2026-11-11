import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

/**
 * Seeds what `apps/web/tests/task-conversation-real-api.spec.ts` needs in the
 * signed-in admin's organization, as the database owner: an active
 * `coordinator` agent version (the scripted coordinator executes behind it),
 * a funded and priced coding agent bound to the fixed coding preset, and an
 * application, repository and active profile that make a preset run
 * admissible. Prints one JSON line with the ids.
 *
 * Usage: `web-conversation-seed.ts <email>` against the stack named by
 * `DATABASE_URL` (the owner URL `compose-up.sh` writes).
 */
const email = Deno.args[0]?.trim().toLowerCase();
if (!email) {
  console.error("web-conversation-seed: missing required <email> argument");
  Deno.exit(2);
}
const database = openPgDatabase(
  readDatabaseConfig(Deno.env.toObject(), "owner").url,
);
try {
  const scopes = await database.query<
    { principalId: string; organizationId: string }
  >(
    `select principal.id as "principalId", membership.organization_id as "organizationId"
       from bakery.principals principal
       join public."user" provider_user on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships membership on membership.principal_id = principal.id
      where provider_user.email = $1`,
    [email],
  );
  const scope = scopes.rows[0];
  if (!scope) throw new Error("WEB_CONVERSATION_SCOPE_REQUIRED");
  const label = crypto.randomUUID().slice(0, 8);
  const digestOf = async (config: unknown) =>
    await sha256Hex(canonicalJson(config));

  // Active coordinator agent version; the scripted coordinator runs behind it.
  let coordinatorId = (await database.query<{ id: string }>(
    `select id from bakery.agent_definitions where organization_id = $1 and slug = 'coordinator'`,
    [scope.organizationId],
  )).rows[0]?.id;
  if (!coordinatorId) {
    coordinatorId = crypto.randomUUID();
    await database.query(
      `insert into bakery.agent_definitions (id, organization_id, slug, name)
       values ($1, $2, 'coordinator', 'Coordinator')`,
      [coordinatorId, scope.organizationId],
    );
  }
  const revision = (await database.query<{ next: number }>(
    `select coalesce(max(revision), 0) + 1 as next from bakery.agent_versions
      where organization_id = $1 and agent_id = $2`,
    [scope.organizationId, coordinatorId],
  )).rows[0].next;
  const coordinatorVersionId = crypto.randomUUID();
  await database.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision, config, digest, created_by)
     values ($1, $2, $3, $4, '{}'::jsonb, $5, $6)`,
    [
      coordinatorVersionId,
      scope.organizationId,
      coordinatorId,
      Number(revision),
      `digest-${coordinatorVersionId}`,
      scope.principalId,
    ],
  );
  await database.query(
    `update bakery.agent_definitions set active_version_id = $3
      where organization_id = $1 and id = $2`,
    [scope.organizationId, coordinatorId, coordinatorVersionId],
  );

  // Funded, priced coding agent bound to the fixed coding preset.
  const billing = {
    provider: "preset-provider",
    billingAccountId: `preset-account-fs26-${label}`,
    model: "preset-model",
    billingRoute: "api",
    maxTokens: 1_000,
    maxUsdReservation: 1,
    pricingMetadataSnapshot: `preset-price-fs26-${label}`,
  };
  await database.query(
    `insert into bakery.provider_pricing_snapshots (
       provider, billing_account_id, model, billing_type,
       pricing_metadata_snapshot, source_reference, effective_from
     ) values ($1, $2, $3, $4, $5, 'test-provider-pricing-fixture', clock_timestamp())`,
    [
      billing.provider,
      billing.billingAccountId,
      billing.model,
      billing.billingRoute,
      billing.pricingMetadataSnapshot,
    ],
  );
  const config = { harness: "codex", billing };
  const agentId = crypto.randomUUID();
  const agentVersionId = crypto.randomUUID();
  await database.query(
    `insert into bakery.agent_definitions (id, organization_id, slug, name, description)
     values ($1, $2, $3, $4, 'Coding agent bound to the fixed coding preset.')`,
    [
      agentId,
      scope.organizationId,
      `fs26-coder-${label}`,
      `FS26 coder ${label}`,
    ],
  );
  await database.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision, config, digest, created_by)
     values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
    [
      agentVersionId,
      scope.organizationId,
      agentId,
      JSON.stringify(config),
      await digestOf(config),
      scope.principalId,
    ],
  );

  // Application, repository and active profile bound to that agent.
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const profileConfig = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    agentBindings: { "harness.implement": agentVersionId },
  };
  await database.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'FS26 application')`,
    [applicationId, scope.organizationId, `fs26-${applicationId}`],
  );
  await database.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'fs26-owner', $5, 'main')`,
    [
      repositoryId,
      scope.organizationId,
      applicationId,
      crypto.randomUUID(),
      `fs26-${repositoryId}`,
    ],
  );
  await database.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by
     ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
    [
      profileId,
      scope.organizationId,
      applicationId,
      repositoryId,
      JSON.stringify(profileConfig),
      await digestOf(profileConfig),
      scope.principalId,
    ],
  );
  await database.query(
    `update bakery.repositories set active_profile_id = $3
      where organization_id = $1 and id = $2`,
    [scope.organizationId, repositoryId, profileId],
  );
  console.log(JSON.stringify({
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    applicationId,
    repositoryId,
    profileId,
  }));
} finally {
  await closePgDatabase(database);
}
