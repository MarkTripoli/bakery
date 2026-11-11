import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";

export async function seedRunRepositoryScope(
  database: PgDatabase,
  scope: Readonly<
    { organizationId: string; principalId: string; applicationId: string }
  >,
): Promise<{ repositoryId: string; profileId: string; profileDigest: string }> {
  const repositoryId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  const profileDigest = await sha256Hex(canonicalJson(config));
  await database.query(
    `insert into bakery.repositories
    (id,organization_id,application_id,integration_connection_id,provider_repo_id,owner,name,default_branch)
    values ($1,$2,$3,$4,$5,'seeded-read','bakery','main')`,
    [
      repositoryId,
      scope.organizationId,
      scope.applicationId,
      crypto.randomUUID(),
      `seeded-${repositoryId}`,
    ],
  );
  await database.query(
    `insert into bakery.repository_profiles
    (id,organization_id,application_id,repository_id,revision,config,digest,created_by)
    values ($1,$2,$3,$4,1,$5::jsonb,$6,$7)`,
    [
      profileId,
      scope.organizationId,
      scope.applicationId,
      repositoryId,
      JSON.stringify(config),
      profileDigest,
      scope.principalId,
    ],
  );
  return { repositoryId, profileId, profileDigest };
}
