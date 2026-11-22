import { assertEquals } from "@std/assert";
import {
  call,
  type Fixture,
  install,
  publishWithPages,
  type withPluginFixture,
} from "./plugin-pages-fixture.ts";

/**
 * Real-route helpers for moving a plugin install between versions (#34): publish
 * a version with a chosen manifest, move an install, write state, and read back
 * the rows a move is supposed to keep or leave alone. They drive the routes a
 * caller does and read the tables afterwards, because a refusal that still wrote
 * a row is the failure that matters and a status code cannot see it.
 */

type Store = Parameters<Parameters<typeof withPluginFixture>[0]>[1];

/** A manifest that can be installed, with the parts a move cares about changed. */
export function manifestOf(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "demo-plugin",
    requestedCapabilities: ["state.read", "state.write"],
    stateSchemaVersion: 1,
    stateNamespaces: ["settings"],
    ...overrides,
  };
}

/** Publish a version of a package (a new package when none is named). */
export async function publishVersion(
  fixture: Fixture,
  store: Store,
  manifest: Record<string, unknown>,
  packageId?: string,
): Promise<{ packageId: string; versionId: string }> {
  const published = await publishWithPages(fixture, store, manifest, {
    "bundle.txt": crypto.randomUUID(),
  }, packageId);
  assertEquals(
    published.response.status,
    201,
    await published.response.clone().text(),
  );
  return { packageId: published.packageId, versionId: published.versionId };
}

/** Install a freshly published first version and say what it is. */
export async function installFirst(
  fixture: Fixture,
  store: Store,
  manifest: Record<string, unknown> = manifestOf(),
  scope: "organization" | "personal" = "organization",
) {
  const published = await publishVersion(fixture, store, manifest);
  const installId = await install(fixture, published, scope);
  return { ...published, installId };
}

/** Ask for a change to an install and return the response. */
export function patchInstall(
  fixture: Fixture,
  installId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return call(fixture, `/v1/plugin-installs/${installId}`, {
    method: "PATCH",
    body,
  });
}

/** A change that must answer 200, as the install. */
export async function moveInstall(
  fixture: Fixture,
  installId: string,
  body: Record<string, unknown>,
) {
  const response = await patchInstall(fixture, installId, body);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

/** Write one shared state key through the route. */
export function putState(
  fixture: Fixture,
  installId: string,
  input: {
    key: string;
    value: unknown;
    schemaVersion: number;
    expectedCasVersion: number;
    namespace?: string;
  },
): Promise<Response> {
  const namespace = input.namespace ?? "settings";
  return call(
    fixture,
    `/v1/plugin-installs/${installId}/state/${namespace}/${input.key}`,
    {
      method: "PUT",
      body: {
        namespace,
        key: input.key,
        schemaVersion: input.schemaVersion,
        value: input.value,
        expectedCasVersion: input.expectedCasVersion,
      },
    },
  );
}

/** A state write that must succeed, returning the stored item. */
export async function writeState(
  fixture: Fixture,
  installId: string,
  input: Parameters<typeof putState>[2],
) {
  const response = await putState(fixture, installId, input);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

export type StateRow = {
  namespace: string;
  key: string;
  schema_version: number;
  cas_version: number;
  value: unknown;
};

/** The state an install holds, ordered so two reads compare equal. */
export async function stateRows(
  fixture: Fixture,
  installId: string,
): Promise<StateRow[]> {
  const result = await fixture.pgDatabase.query<StateRow>(
    `select namespace, key, schema_version, cas_version, value
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2
      order by namespace, key`,
    [fixture.organizationId, installId],
  );
  return result.rows;
}

/** The capabilities an install holds now, sorted. */
export async function grantsOf(
  fixture: Fixture,
  installId: string,
): Promise<string[]> {
  const result = await fixture.pgDatabase.query<{ capability: string }>(
    `select capability from bakery.plugin_install_grants
      where organization_id = $1 and plugin_install_id = $2
      order by capability`,
    [fixture.organizationId, installId],
  );
  return result.rows.map((row) => row.capability);
}

/** The snapshot an install keeps, with its rows, or null. */
export async function snapshotOf(
  fixture: Fixture,
  installId: string,
): Promise<
  | {
    fromVersionId: string;
    fromStateSchemaVersion: number;
    rowCount: number;
    rows: { key: string; schema_version: number; value: unknown }[];
  }
  | null
> {
  const header = await fixture.pgDatabase.query<{
    id: string;
    from_plugin_version_id: string;
    from_state_schema_version: number;
    state_row_count: number;
  }>(
    `select id, from_plugin_version_id, from_state_schema_version, state_row_count
       from bakery.plugin_install_snapshots
      where organization_id = $1 and plugin_install_id = $2`,
    [fixture.organizationId, installId],
  );
  const found = header.rows[0];
  if (found === undefined) return null;
  const rows = await fixture.pgDatabase.query<
    { key: string; schema_version: number; value: unknown }
  >(
    `select key, schema_version, value
       from bakery.plugin_install_snapshot_state
      where organization_id = $1 and plugin_install_snapshot_id = $2
      order by key`,
    [fixture.organizationId, found.id],
  );
  return {
    fromVersionId: found.from_plugin_version_id,
    fromStateSchemaVersion: found.from_state_schema_version,
    rowCount: found.state_row_count,
    rows: rows.rows,
  };
}

/** The version an install pins, read from the table. */
export async function pinnedVersion(
  fixture: Fixture,
  installId: string,
): Promise<string> {
  const result = await fixture.pgDatabase.query<{ plugin_version_id: string }>(
    `select plugin_version_id from bakery.plugin_installs
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, installId],
  );
  return result.rows[0].plugin_version_id;
}
