import type { ActionContext } from "@bakery/contracts/action-registry";
import { isUuid } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { RepositoryVersionedProfileConfigSchema } from "@bakery/contracts/repository-inspection";
import {
  type OrganizationRepositoryRuleEntry,
  type OrganizationRepositoryRules,
  type RepositoryRuleOverrides,
  resolveRepositoryRules,
  validateRepositoryRuleOverrides,
} from "@bakery/contracts/repository-rules";
import type { PgTransactionClient } from "../../platform/database.ts";
import { readLatestRuleVersionRow } from "./postgres.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

const NO_OVERRIDES: RepositoryRuleOverrides = Object.freeze({ entries: [] });

export function organizationRules(
  row: { revision: number; config: { entries?: unknown } | null } | undefined,
): OrganizationRepositoryRules | null {
  if (!row) return null;
  return {
    revision: row.revision,
    entries: (row.config?.entries ?? []) as OrganizationRepositoryRuleEntry[],
  };
}

/**
 * Latest published organization baseline for one organization, or null when
 * nothing is published (reads through the one shared, org-bound reader).
 */
async function readLatestOrganizationRules(
  transaction: PgTransactionClient,
  organizationId: string,
): Promise<OrganizationRepositoryRules | null> {
  return organizationRules(
    await readLatestRuleVersionRow(transaction, organizationId),
  );
}

/**
 * Checks profile overrides against the organization baseline the caller
 * validated against. Must run inside the transaction that holds the shared
 * organization advisory lock, so no organization revision can commit between
 * this read and the profile insert.
 *
 * - latest revision differs from `expectedRevision` -> PRECONDITION_FAILED
 * - any override replaces or disables a locked rule -> UNPROCESSABLE naming
 *   every conflicting rule key at `config.repositoryRules.entries[i].ruleKey`
 */
export async function assertRepositoryOverridesAllowed(
  transaction: PgTransactionClient,
  organizationId: string,
  expectedRevision: number,
  overrides: RepositoryRuleOverrides,
): Promise<void> {
  const organization = await readLatestOrganizationRules(
    transaction,
    organizationId,
  );
  if ((organization?.revision ?? 0) !== expectedRevision) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const validation = validateRepositoryRuleOverrides(organization, overrides);
  if (validation.ok) return;
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: validation.conflicts.map((conflict) => ({
        path: [
          "config",
          "repositoryRules",
          "entries",
          overrides.entries.findIndex((entry) =>
            entry.ruleKey === conflict.ruleKey
          ),
          "ruleKey",
        ],
        code: conflict.reason,
        message: `Rule ${conflict.ruleKey} is locked by the organization: ${
          conflict.reason.replaceAll("_", " ")
        }.`,
      })),
    },
  });
}

/**
 * Bakery checker availability: every enabled warn or require entry that
 * declares a check binding must bind a command of the active fixed policy.
 * A require entry without a working checker is unavailable, never a pass.
 */
export function checkerAvailability(
  entries: readonly {
    ruleKey: string;
    enabled: boolean;
    mode: string;
    options: object;
  }[],
  commandIds: ReadonlySet<string>,
): {
  state: "configured" | "unavailable" | "not_required";
  unavailableRuleKeys: string[];
} {
  let needed = 0;
  const unavailableRuleKeys: string[] = [];
  for (const entry of entries) {
    if (!entry.enabled || (entry.mode !== "warn" && entry.mode !== "require")) {
      continue;
    }
    if (!("checkBinding" in entry.options)) continue;
    needed += 1;
    const binding = (entry.options as { checkBinding: string | null })
      .checkBinding;
    if (binding === null || !commandIds.has(binding)) {
      unavailableRuleKeys.push(entry.ruleKey);
    }
  }
  return {
    state: needed === 0
      ? "not_required"
      : unavailableRuleKeys.length > 0
      ? "unavailable"
      : "configured",
    unavailableRuleKeys,
  };
}

type EffectiveRow = {
  repository_id: string;
  repository_version: number;
  provider_connected: boolean;
  profile_id: string | null;
  profile_revision: number | null;
  profile_config: unknown;
  organization_revision: number | null;
  organization_config: { entries?: unknown } | null;
};

/**
 * Effective rules of one repository. One statement reads the repository, its
 * active profile and the latest organization baseline, so the three share a
 * snapshot and the entries' organization revision is the revision they were
 * resolved against. Every table read carries the explicit organization
 * predicate; an id outside the caller's organization is indistinguishable
 * from an unknown one (404).
 */
export async function getEffectiveRepositoryRules(
  context: ActionContext,
) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const repositoryId = context.params.id;
  if (!isUuid(repositoryId)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const result = await transaction.query<EffectiveRow>(
    `select r.id as repository_id,
            r.version as repository_version,
            exists (
              select 1 from bakery.integration_connections c
               where c.organization_id = r.organization_id
                 and c.id = r.integration_connection_id
                 and c.status = 'enabled' and c.archived_at is null
            ) as provider_connected,
            p.id as profile_id,
            p.revision as profile_revision,
            p.config as profile_config,
            o.revision as organization_revision,
            o.config as organization_config
       from bakery.repositories r
       left join bakery.repository_profiles p
         on p.organization_id = r.organization_id
        and p.repository_id = r.id
        and p.id = r.active_profile_id
       left join lateral (
         select v.revision, v.config
           from bakery.organization_repository_rule_versions v
          where v.organization_id = r.organization_id
          order by v.revision desc
          limit 1
       ) o on true
      where r.organization_id = $1 and r.id = $2`,
    [organizationId, repositoryId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  let overrides = NO_OVERRIDES;
  let commandIds: ReadonlySet<string> = new Set();
  if (row.profile_id !== null) {
    const config = RepositoryVersionedProfileConfigSchema.safeParse(
      row.profile_config,
    );
    if (!config.success) {
      // Same answer admission gives an unparsable active profile.
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "configuration_profile_unavailable" },
      });
    }
    overrides = config.data.repositoryRules ?? NO_OVERRIDES;
    commandIds = new Set(
      (config.data.fixedPolicy?.commands ?? []).map((command) => command.id),
    );
  }
  const organization = row.organization_revision === null
    ? null
    : organizationRules({
      revision: row.organization_revision,
      config: row.organization_config,
    });
  const resolved = await resolveRepositoryRules(organization, overrides);
  return {
    repositoryVersion: row.repository_version,
    checkers: checkerAvailability(resolved.entries, commandIds),
    providerProtection: {
      state: "unknown" as const,
      reason: row.provider_connected
        ? "not_checked" as const
        : "provider_not_connected" as const,
    },
    repositoryId: row.repository_id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    organizationRevision: resolved.organizationRevision,
    entries: resolved.entries,
    supersededOverrides: resolved.supersededOverrides,
    digest: resolved.digest,
  };
}
