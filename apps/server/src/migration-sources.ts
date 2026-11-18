import type { MigrationSource } from "./platform/migration-definition.ts";
import { bakeryPlatformMigrationSource } from "./platform/migration-definition.ts";
import { authBakeryMigrationSource } from "./modules/auth/migrations.ts";
import { workBakeryMigrationSource } from "./modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "./modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "./modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "./modules/repository-rules/migrations.ts";
import { artifactKindsBakeryMigrationSource } from "./modules/artifact-kinds/migrations.ts";
import { integrationsBakeryMigrationSource } from "./modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "./modules/delivery/migrations.ts";
import { mcpBakeryMigrationSource } from "./modules/mcp/migrations.ts";
import { knowledgeBakeryMigrationSource } from "./modules/knowledge/migrations.ts";

/**
 * Every bakery-owned migration directory, in one place
 * (docs/technical-design/09-integrations.md 12.8, rail B3).
 *
 * Before this file the list was typed out in `tasks.ts` and again as
 * `--allow-read=` paths in `apps/server/package.json`, and the four rails that
 * need it each had their own copy. Five hand-maintained copies of one fact meant
 * a new module could be migratable at runtime while invisible to a rail, or
 * readable by one task and not another. Adding a module is now one import and one
 * entry here, and a rail reads this list instead of trusting a second list to
 * agree with it.
 *
 * Order is the global sequence: every module's migrations are numbered from the
 * same space, so the concatenation is applied in numeric order and a module's
 * position in this array does not affect when its migrations run.
 */
export const BAKERY_MIGRATION_SOURCES: readonly MigrationSource[] = Object
  .freeze([
    bakeryPlatformMigrationSource,
    authBakeryMigrationSource,
    workBakeryMigrationSource,
    projectsBakeryMigrationSource,
    agentsBakeryMigrationSource,
    repositoryRulesBakeryMigrationSource,
    artifactKindsBakeryMigrationSource,
    integrationsBakeryMigrationSource,
    deliveryBakeryMigrationSource,
    mcpBakeryMigrationSource,
    knowledgeBakeryMigrationSource,
  ]);

/**
 * The `--allow-read=` value the server process needs, derived from the sources
 * themselves.
 *
 * A source root is a `file://` URL under `src/`; Deno wants a plain relative path
 * to the directory it may read. Deriving this from the same list is what stops
 * the two from disagreeing.
 */
export function bakeryMigrationReadPaths(): string[] {
  return BAKERY_MIGRATION_SOURCES.map((source) => {
    const path = new URL(source.root).pathname;
    const marker = "/src/";
    const index = path.lastIndexOf(marker);
    return index === -1 ? path : `src/${path.slice(index + marker.length)}`;
  });
}
