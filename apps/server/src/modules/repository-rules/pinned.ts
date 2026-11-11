import { StandardError } from "@bakery/contracts/http";
import {
  type OrganizationRepositoryRules,
  OrganizationRepositoryRulesSchema,
  type PinnedRepositoryRules,
  pinRepositoryRules,
  RepositoryRuleOverridesSchema,
  resolveRepositoryRules,
} from "@bakery/contracts/repository-rules";
import type { PgTransactionClient } from "../../platform/database.ts";
import { repositoryRuleVersionDigest } from "./postgres.ts";

/** The pinned profile an admission resolves rules for; already authorized. */
export type RulesPinProfile = {
  readonly repositoryId: string;
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  /** Overrides frozen in the profile config the run snapshot carries. */
  readonly repositoryRules: unknown;
};

type PinRow = {
  profile_revision: number;
  profile_digest: string;
  organization_revision: number | null;
  organization_config: { entries?: unknown } | null;
  organization_digest: string | null;
};

const NO_OVERRIDES = Object.freeze({ entries: [] });

export function rulesUnavailable(cause?: unknown): never {
  throw new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "repository_rules_unavailable" },
    cause,
  });
}

/**
 * The one verification of a stored organization version: the entries must
 * satisfy the rule schema and the stored digest must match their content,
 * otherwise the read fails closed. Admission and the workflow guard share it.
 */
export async function parseStoredOrganizationRules(
  row: {
    readonly revision: number;
    readonly config: { entries?: unknown } | null;
    readonly digest: string | null;
  },
): Promise<OrganizationRepositoryRules> {
  const parsed = OrganizationRepositoryRulesSchema.safeParse({
    revision: row.revision,
    entries: row.config?.entries,
  });
  if (!parsed.success) rulesUnavailable(parsed.error);
  if (
    await repositoryRuleVersionDigest(
      parsed.data.revision,
      parsed.data.entries,
    ) !== row.digest
  ) rulesUnavailable();
  return parsed.data;
}

/**
 * Resolves and pins the effective rules of one admission. One statement reads
 * the pinned profile row and the latest organization baseline, so both come
 * from one snapshot; both table reads carry the explicit organization
 * predicate, and a profile outside the caller's organization yields the same
 * refusal as an unknown one. Stored rules that fail their schema, or a version
 * row whose digest no longer matches its content, fail closed instead of
 * degrading to the empty baseline. Call it once per admission, then freeze the
 * result: nothing may read rules again for the same run.
 */
export async function pinEffectiveRepositoryRules(
  transaction: PgTransactionClient,
  organizationId: string,
  profile: RulesPinProfile,
): Promise<PinnedRepositoryRules> {
  const result = await transaction.query<PinRow>(
    `select p.revision as profile_revision,
            p.digest as profile_digest,
            o.revision as organization_revision,
            o.config as organization_config,
            o.digest as organization_digest
       from bakery.repository_profiles p
       left join lateral (
         select v.revision, v.config, v.digest
           from bakery.organization_repository_rule_versions v
          where v.organization_id = p.organization_id
          order by v.revision desc
          limit 1
       ) o on true
      where p.organization_id = $1 and p.repository_id = $2 and p.id = $3`,
    [organizationId, profile.repositoryId, profile.id],
  );
  const row = result.rows[0];
  if (
    !row || row.profile_revision !== profile.revision ||
    row.profile_digest !== profile.digest
  ) rulesUnavailable();
  const organization = row.organization_revision === null
    ? null
    : await parseStoredOrganizationRules({
      revision: row.organization_revision,
      config: row.organization_config,
      digest: row.organization_digest,
    });
  const overrides = RepositoryRuleOverridesSchema.safeParse(
    profile.repositoryRules ?? NO_OVERRIDES,
  );
  if (!overrides.success) rulesUnavailable(overrides.error);
  return pinRepositoryRules(
    await resolveRepositoryRules(organization, overrides.data),
    profile,
  );
}
