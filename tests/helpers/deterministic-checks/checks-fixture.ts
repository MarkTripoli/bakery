import type { ActionContext } from "../../../packages/contracts/src/action-registry.ts";
import { DeliveryImplementedAction } from "../../../packages/contracts/src/implemented-actions.ts";
import { readTestDatabaseConfig } from "../../../packages/config/src/env.ts";
import {
  createDeliveryActionRegistry,
  createDeliveryHandlers,
} from "../../../apps/server/src/modules/delivery/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import {
  openOutboxTestFixture,
  type OutboxTestFixture,
} from "../outbox-fixture.ts";
import type { RunScope } from "./run-fixture.ts";

const cursorSecret = "deterministic-checks-cursor-secret";

export type MemberRole = "admin" | "developer" | "viewer" | "guest";

/** One page of the `checks.list` response. */
export type CheckRunPage = {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
};

export type ChecksFixture = {
  readonly fixture: OutboxTestFixture;
  /** Owner-role connection for seeding and assertions only. */
  readonly owner: PgDatabase;
  /** A developer member of `fixture.organizationId`; the default caller. */
  readonly principalId: string;
  /** A second organization the default caller does not belong to. */
  readonly otherOrganizationId: string;
  /** Creates a service principal with a membership in `organizationId`. */
  addPrincipal(
    organizationId: string,
    role: MemberRole | null,
  ): Promise<string>;
  /** Runs `checks.list` through the real registry and authority runner. */
  list(
    organizationId: string,
    runId: string,
    query?: { cursor?: string; limit?: number },
    asPrincipalId?: string,
  ): Promise<CheckRunPage>;
  scope(organizationId?: string): RunScope;
  close(): Promise<void>;
};

/**
 * Opens a migrated test database with a developer principal, a second
 * organization, and the real `checks.list` registry. Teardown deletes the
 * organizations before the principals that created their conversations.
 */
export async function openChecksFixture(): Promise<ChecksFixture> {
  const fixture = await openOutboxTestFixture();
  const owner = openPgDatabase(readTestDatabaseConfig().databaseUrl);
  const otherOrganizationId = crypto.randomUUID();
  const principals: string[] = [];
  const now = new Date("2026-10-31T00:00:00.000Z");
  const addPrincipal = async (
    organizationId: string,
    role: MemberRole | null,
  ): Promise<string> => {
    const principalId = crypto.randomUUID();
    principals.push(principalId);
    await owner.query(
      `insert into bakery.principals
         (id, provider_user_id, display_name, principal_type)
       values ($1, null, 'Check reader', 'service')`,
      [principalId],
    );
    if (role !== null) {
      await owner.query(
        `insert into bakery.organization_memberships
           (id, organization_id, principal_id, role, status, joined_at,
            created_at, updated_at, version)
         values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)`,
        [crypto.randomUUID(), organizationId, principalId, role, now],
      );
    }
    return principalId;
  };
  await owner.query(
    `insert into bakery.organizations
       (id, name, slug, metadata, created_at, updated_at, version)
     values ($1, 'Other Org', $2, '{}'::jsonb, $3, $3, 1)`,
    [otherOrganizationId, `other-${otherOrganizationId}`, now],
  );
  const principalId = await addPrincipal(fixture.organizationId, "developer");
  const registry = createDeliveryActionRegistry(
    fixture.appPg,
    createDeliveryHandlers(cursorSecret),
  );
  return {
    fixture,
    owner,
    principalId,
    otherOrganizationId,
    addPrincipal,
    scope: (organizationId = fixture.organizationId) => ({
      organizationId,
      principalId,
    }),
    async list(organizationId, runId, query = {}, asPrincipalId = principalId) {
      const context: ActionContext = {
        request: new Request(`http://test/v1/runs/${runId}/checks`, {
          headers: { "Bakery-Organization-Id": organizationId },
        }),
        params: { id: runId },
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        signal: new AbortController().signal,
        principal: {
          principalId: asPrincipalId,
          principalType: "service",
          displayName: "Check reader",
        },
      };
      return await registry.execute(
        DeliveryImplementedAction.ChecksList,
        context,
        query,
      ) as CheckRunPage;
    },
    async close() {
      // Organizations first: their conversations and tasks reference the
      // principals, so a principal can only go once both are gone.
      for (const id of [otherOrganizationId, fixture.organizationId]) {
        await owner.query("delete from bakery.organizations where id = $1", [
          id,
        ]);
      }
      for (const id of principals) {
        await owner.query("delete from bakery.principals where id = $1", [id]);
      }
      await closePgDatabase(owner);
      await fixture.close();
    },
  };
}
