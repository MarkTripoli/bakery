import {
  TICKET_PRESET_IDS,
  workflowPresetById,
  type WorkflowPresetDefinition,
} from "@bakery/contracts/workflow-presets";
import {
  type DataMigration,
  type DataMigrationConnection,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";
import { upgradeSourcePolicyToWorkflow } from "../../ticket-store.ts";

const ORGANIZATIONS_PER_BATCH = 20;

type JsonValue = Parameters<DataMigrationConnection["json"]>[0];

type Pin = { workflowId: string; versionId: string; digest: string };
type BuiltIn = {
  workflowId: string;
  current: Pin;
  byRevision: ReadonlyMap<number, Pin>;
};

function builtInPresets(): WorkflowPresetDefinition[] {
  return TICKET_PRESET_IDS.map((id) => {
    const preset = workflowPresetById(id);
    if (preset === undefined) throw new Error("TICKET_PRESET_UNKNOWN");
    return preset;
  });
}

async function installer(
  transaction: DataMigrationConnection,
  organizationId: string,
): Promise<string | null> {
  const rows = await transaction<{ principal_id: string }[]>`
    select principal_id from (
      select principal_id, 0 as rank, joined_at as at
        from bakery.organization_memberships
       where organization_id = ${organizationId}
      union all
      select authority_principal_id, 1, created_at
        from bakery.ticket_requests
       where organization_id = ${organizationId}
         and authority_principal_id is not null
    ) as candidate
    order by rank, at
    limit 1`;
  return rows[0]?.principal_id ?? null;
}

async function installBuiltIn(
  transaction: DataMigrationConnection,
  organizationId: string,
  principalId: string | null,
  preset: WorkflowPresetDefinition,
): Promise<BuiltIn | null> {
  if (principalId !== null) {
    await transaction`
      insert into bakery.workflow_definitions (
        organization_id, slug, name, description, enabled,
        origin_kind, origin_catalog_key, origin_catalog_version
      ) values (
        ${organizationId}, ${preset.slug}, ${preset.id},
        'Code-owned workflow preset materialized by the server.', true,
        'catalog', ${preset.id}, ${preset.revision}
      )
      on conflict (organization_id, slug) do nothing`;
  }
  const definitions = await transaction<{ id: string }[]>`
    select id from bakery.workflow_definitions
     where organization_id = ${organizationId} and slug = ${preset.slug}
       and origin_kind = 'catalog'`;
  const workflowId = definitions[0]?.id;
  if (workflowId === undefined) return null;
  if (principalId !== null) {
    await transaction`
      insert into bakery.workflow_versions (
        organization_id, workflow_id, revision, source_yaml, normalized_spec,
        digest, status, created_by
      ) values (
        ${organizationId}, ${workflowId}, ${preset.revision},
        ${preset.sourceYaml}, ${transaction.json(preset.spec as JsonValue)},
        ${preset.digest}, 'published', ${principalId}
      )
      on conflict (workflow_id, revision) do nothing`;
  }
  const versions = await transaction<
    { id: string; revision: number; digest: string }[]
  >`
    select id, revision, digest from bakery.workflow_versions
     where organization_id = ${organizationId} and workflow_id = ${workflowId}
       and status = 'published'
     order by revision desc`;
  const newest = versions[0];
  if (newest === undefined) return null;
  const byRevision = new Map(
    versions.map((version) => [version.revision, {
      workflowId,
      versionId: version.id,
      digest: version.digest,
    }]),
  );
  const current = byRevision.get(preset.revision) ?? byRevision.get(
    newest.revision,
  )!;
  await transaction`
    update bakery.workflow_definitions
       set active_version_id = ${current.versionId}, updated_at = now(),
           version = version + 1
     where organization_id = ${organizationId} and id = ${workflowId}
       and active_version_id is null`;
  return { workflowId, current, byRevision };
}

function policyOf(
  policy: Record<string, unknown>,
  builtIns: ReadonlyMap<string, BuiltIn>,
): Record<string, unknown> {
  const { preset, ...rest } = policy;
  const builtIn = typeof preset === "string" ? builtIns.get(preset) : undefined;
  return {
    ...rest,
    version: 2,
    ...(builtIn === undefined
      ? {}
      : { workflow: { workflowId: builtIn.workflowId, builtIn: preset } }),
  };
}

async function upgradeOrganization(
  transaction: DataMigrationConnection,
  organizationId: string,
): Promise<void> {
  const principalId = await installer(transaction, organizationId);
  const builtIns = new Map<string, BuiltIn>();
  for (const preset of builtInPresets()) {
    const installed = await installBuiltIn(
      transaction,
      organizationId,
      principalId,
      preset,
    );
    if (installed !== null) builtIns.set(preset.id, installed);
  }
  const sources = await transaction<
    { id: string; policy: Record<string, unknown> }[]
  >`
    select id, policy from bakery.ticket_sources
     where organization_id = ${organizationId} and policy ->> 'version' = '1'
     order by id
     for update`;
  for (const source of sources) {
    await upgradeSourcePolicyToWorkflow(
      (text, parameters) => transaction.unsafe(text, parameters as JsonValue[]),
      organizationId,
      source.id,
      policyOf(source.policy, builtIns),
    );
  }
}

export const ticketPolicyWorkflowBackfill: DataMigration = {
  version: "0373_ticket_policy_names_a_workflow",
  source: new URL(import.meta.url),
  async run(connection, options) {
    for (let batch = 0; batch < options.maxBatches; batch++) {
      const count = await runDataMigrationBatch(
        connection,
        async (transaction) => {
          const organizations = await transaction<
            { organization_id: string }[]
          >`
            select distinct organization_id from bakery.ticket_sources
             where policy ->> 'version' = '1'
             order by organization_id
             limit ${ORGANIZATIONS_PER_BATCH}`;
          for (const organization of organizations) {
            await upgradeOrganization(
              transaction,
              organization.organization_id,
            );
          }
          return organizations.length;
        },
        options.beforeCommit,
      );
      if (count === 0) return true;
    }
    return false;
  },
};
