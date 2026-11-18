import { assert, assertEquals } from "@std/assert";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import { loadSnapshot } from "../../apps/server/src/modules/catalog/authority-snapshot-postgres.ts";
import type { ActiveIntegrationRegistry } from "../../apps/server/src/modules/catalog/integration-gate.ts";

/**
 * The snapshot carries the numeric repository id into the resource.
 *
 * #640's High: the credential store narrowed a GitHub App token to
 * `subject.repositoryId`, and the snapshot filled only
 * `resource.binding.repositoryId`, so in production the token had nothing to be
 * narrowed to and the real client refused an empty set at the last moment. The
 * unit fixture set the id by hand, which is why the gap survived review: the gap
 * was in the shape the fixture did not use.
 */

const ORG = "00000000-0000-4000-8000-000000003201";
const ACTOR = "00000000-0000-4000-8000-000000003202";
const CONNECTION = "00000000-0000-4000-8000-000000003203";
const RESOURCE = "00000000-0000-4000-8000-000000003204";
const INSTALL = "00000000-0000-4000-8000-000000003205";

const KEY = {
  organizationId: ORG,
  actorRef: ACTOR,
  connectionId: CONNECTION,
  resourceId: RESOURCE,
} as const;

function transactionAnswering(
  row: Record<string, unknown> | null,
  /** The Bakery repositories the tracking query finds for this resource. */
  tracked: readonly { id: string }[] = [],
) {
  const queries: string[] = [];
  const transaction = {
    query: (sql: string) => {
      queries.push(sql);
      if (sql.includes("from bakery.integration_connections connection")) {
        return Promise.resolve({
          rows: row === null ? [] : [row],
          rowCount: 1,
        });
      }
      if (sql.includes("from bakery.repositories")) {
        return Promise.resolve({
          rows: [...tracked],
          rowCount: tracked.length,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as PgTransactionClient;
  return { transaction, queries };
}

const BAKERY_REPOSITORY = "00000000-0000-4000-8000-000000003206";

/** A registry holding the one provider this snapshot names. */
const registry = {
  // The snapshot maps the stored provider to the deployed provider id.
  get: (id: string) =>
    id === "bakery.github"
      ? { providerId: "bakery.github", manifestDigest: "d" }
      : undefined,
} as unknown as ActiveIntegrationRegistry;

const row = {
  principal_id: ACTOR,
  disabled_at: null,
  connection_status: "enabled",
  connection_health: "ok",
  granted_permissions: { contents: "read" },
  installation_id: INSTALL,
  installation_provider: "github",
  installation_status: "enabled",
  external_authorization_id: "1234",
  bot_user_id: "77",
  // The STORED kind; the gate kind is what the map produces from it.
  resource_kind: "repository",
  // The provider's numeric id for the repository: the only place it appears.
  resource_external_id: "900",
  resource_display_name: "octo/repo",
  resource_selected: true,
  resource_available: true,
  resource_archived: false,
} as const;

Deno.test("the snapshot names the repository's numeric id on the resource", async () => {
  const { transaction } = transactionAnswering(row);
  const snapshot = await loadSnapshot(transaction, registry, KEY);

  assert(snapshot !== null, "a well-formed row must produce a snapshot");
  // This is the value the token is narrowed to. Without it a granted send is
  // refused by the GitHub client, after every other check has already passed.
  assertEquals(snapshot.resource.providerRepositoryId, "900");
});

Deno.test("the snapshot names the id after the provider, not after a grant", async () => {
  // A grant's `repositoryId` names a Bakery repository record (a uuid) and the
  // provider's number is a different fact. Untracked, there is no Bakery record,
  // so the resource names only the provider's id.
  const { transaction } = transactionAnswering(row);
  const snapshot = await loadSnapshot(transaction, registry, KEY);

  assertEquals("providerRepositoryId" in snapshot!.resource, true);
  assertEquals(
    (snapshot!.resource as Record<string, unknown>).repositoryId,
    undefined,
  );
});

Deno.test("a tracked repository names the Bakery record a grant targets", async () => {
  // qa-qa's #640 Low, fixed at its cause: without this the snapshot named no
  // Bakery repository, so an `into_bakery` grant - which names a repository
  // uuid - could never match, and every repository-bound call was refused.
  const { transaction, queries } = transactionAnswering(row, [
    { id: BAKERY_REPOSITORY },
  ]);
  const snapshot = await loadSnapshot(transaction, registry, KEY);

  assert(
    queries.some((sql) => sql.includes("from bakery.repositories")),
    "the snapshot must look the Bakery repository up",
  );
  assertEquals(snapshot!.resource.repositoryId, BAKERY_REPOSITORY);
  // Both facts at once, and they are not interchangeable.
  assertEquals(snapshot!.resource.providerRepositoryId, "900");
});

Deno.test("two Bakery repositories tracking one provider repository name neither", async () => {
  // The intake treats an ambiguous repository as untracked, and the snapshot
  // must agree: naming one of two would silently grant the wrong repository.
  const { transaction } = transactionAnswering(row, [
    { id: BAKERY_REPOSITORY },
    { id: "00000000-0000-4000-8000-000000003207" },
  ]);
  const snapshot = await loadSnapshot(transaction, registry, KEY);

  assertEquals(
    (snapshot!.resource as Record<string, unknown>).repositoryId,
    undefined,
  );
});

Deno.test("the binding keeps the same numeric id as an integer", async () => {
  const { transaction } = transactionAnswering(row);
  const snapshot = await loadSnapshot(transaction, registry, KEY);

  // Two spellings of one fact, and they must not drift: the binding is what the
  // provider templates interpolate, the resource is what a credential narrows to.
  assertEquals(snapshot!.resource.binding.repositoryId, 900);
});

Deno.test("a resource whose numeric id is malformed yields no snapshot at all", async () => {
  const { transaction } = transactionAnswering({
    ...row,
    resource_external_id: "not-a-number",
  });
  const snapshot = await loadSnapshot(transaction, registry, KEY);

  // Refusing the whole snapshot, rather than carrying a null id, is what keeps
  // the window closed: nothing downstream can mint from a binding it cannot name.
  assertEquals(snapshot, null);
});
