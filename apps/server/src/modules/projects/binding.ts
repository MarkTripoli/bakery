import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  admitRepositoryProfile,
  type RepositoryExecutionPins,
} from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  MAX_REPOSITORY_BINDING_CANDIDATES,
  normalizeRoleBindingKey,
} from "./roles.ts";

const MAX_ALIAS_SELECTOR_VALUES = 32;

export type ExecutableBinding = RepositoryExecutionPins;

export type RepositoryBindingSelector =
  | { repositoryId: string }
  | { role: string; alias?: string | null }
  | { aliases: readonly string[] };

type NormalizedRepositoryBindingSelector =
  | { kind: "repository"; repositoryId: string }
  | { kind: "role"; role: string; alias: string | null }
  | { kind: "aliases"; aliases: readonly string[] };

export type RepositoryBindingCandidate = {
  bindingId: string;
  repositoryId: string;
  role: string;
  alias: string | null;
  provenance: string | null;
  repositoryArchived: boolean;
  profileRevision: number | null;
  hasEligibleObservation: boolean;
};

export type ResolvedRepositoryBinding = {
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  repositoryProfileId: string | null;
  repositoryProfileRevision: number | null;
  repositoryProfileDigest: string | null;
  observationId: string | null;
  observationDigest: string | null;
  baseSha: string | null;
};

export type RepositoryBindingUnavailableReason =
  | "no_matching_binding"
  | "repository_not_found"
  | "repository_archived";

export type RepositoryBindingResolution =
  | { status: "resolved"; binding: ResolvedRepositoryBinding }
  | {
    status: "unavailable";
    reason: RepositoryBindingUnavailableReason;
  }
  | {
    status: "ambiguous";
    candidates: RepositoryBindingCandidate[];
    truncated: boolean;
  }
  | { status: "foreign"; reason: "repository_scope_mismatch" };

type BindingRow = {
  organization_id: string;
  binding_id: string | null;
  binding_role: string | null;
  binding_alias: string | null;
  binding_provenance: string | null;
  repository_id: string;
  repository_slug: string | null;
  application_id: string;
  archived_at: Date | string | null;
  profile_id: string | null;
  profile_revision: number | null;
  profile_digest: string | null;
  profile_config: unknown;
  default_branch: string;
  admitted?: RepositoryExecutionPins;
};

/**
 * Canonicalizes a binding selector before it reaches SQL. The aliases form is
 * an explicit OR-set; it is never ordered preference, so duplicate aliases
 * are rejected instead of silently collapsing to one candidate.
 */
export function normalizeRepositoryBindingSelector(
  input: unknown,
): NormalizedRepositoryBindingSelector {
  if (typeof input === "string") {
    if (input.trim() === "") {
      throw unprocessable(["repositoryId"], "repository_id_invalid");
    }
    return { kind: "repository", repositoryId: input };
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw unprocessable([], "binding_selector_invalid");
  }

  const value = input as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(value, "repositoryId")) {
    if (
      Object.keys(value).length !== 1 ||
      typeof value.repositoryId !== "string"
    ) {
      throw unprocessable(["repositoryId"], "binding_selector_invalid");
    }
    if (value.repositoryId.trim() === "") {
      throw unprocessable(["repositoryId"], "repository_id_invalid");
    }
    return { kind: "repository", repositoryId: value.repositoryId };
  }

  if (Object.prototype.hasOwnProperty.call(value, "aliases")) {
    if (
      Object.keys(value).length !== 1 ||
      !Array.isArray(value.aliases) ||
      value.aliases.length === 0 ||
      value.aliases.length > MAX_ALIAS_SELECTOR_VALUES
    ) {
      throw unprocessable(["aliases"], "aliases_invalid");
    }
    const aliases = value.aliases.map((alias, index) =>
      normalizeRoleBindingKey(alias, ["aliases", index])
    );
    if (new Set(aliases).size !== aliases.length) {
      throw unprocessable(["aliases"], "aliases_duplicate");
    }
    return { kind: "aliases", aliases };
  }

  if (Object.prototype.hasOwnProperty.call(value, "role")) {
    if (Object.keys(value).some((key) => key !== "role" && key !== "alias")) {
      throw unprocessable(["role"], "binding_selector_invalid");
    }
    const role = normalizeRoleBindingKey(value.role, ["role"]);
    const alias = value.alias === undefined || value.alias === null
      ? null
      : normalizeRoleBindingKey(value.alias, ["alias"]);
    return { kind: "role", role, alias };
  }

  throw unprocessable([], "binding_selector_invalid");
}

function candidateFromRow(row: BindingRow): RepositoryBindingCandidate {
  if (row.binding_id === null || row.binding_role === null) {
    throw new Error("PROJECTS_BINDING_CANDIDATE_MISSING_IDENTITY");
  }
  return {
    bindingId: row.binding_id,
    repositoryId: row.repository_id,
    role: row.binding_role,
    alias: row.binding_alias,
    provenance: row.binding_provenance,
    repositoryArchived: row.archived_at !== null,
    profileRevision: row.profile_revision,
    hasEligibleObservation: row.admitted?.observationId != null,
  };
}

async function retainExecutableProfile(
  transaction: PgTransactionClient,
  row: BindingRow,
): Promise<void> {
  if (
    row.profile_id !== null && row.profile_revision !== null &&
    row.profile_digest !== null
  ) {
    try {
      const admitted = await admitRepositoryProfile(transaction, {
        organizationId: row.organization_id,
        applicationId: row.application_id,
        repositoryId: row.repository_id,
      }, {
        id: row.profile_id,
        revision: row.profile_revision,
        digest: row.profile_digest,
        config: row.profile_config,
      });
      if (admitted.config.branches.base === row.default_branch) {
        row.admitted = admitted;
        return;
      }
    } catch (error) {
      if (
        !(error instanceof StandardError) || error.code !== "STATE_CONFLICT"
      ) throw error;
    }
  }
  row.profile_id = null;
  row.profile_revision = null;
  row.profile_digest = null;
}

async function resolutionFromRows(
  transaction: PgTransactionClient,
  selector: NormalizedRepositoryBindingSelector,
  rows: BindingRow[],
): Promise<RepositoryBindingResolution> {
  if (rows.length === 0) {
    return {
      status: "unavailable",
      reason: selector.kind === "repository"
        ? "repository_not_found"
        : "no_matching_binding",
    };
  }
  if (rows.length > 1) {
    const visible = rows.slice(0, MAX_REPOSITORY_BINDING_CANDIDATES);
    await Promise.all(
      visible.map((row) => retainExecutableProfile(transaction, row)),
    );
    return {
      status: "ambiguous",
      candidates: visible.map(candidateFromRow),
      truncated: rows.length > MAX_REPOSITORY_BINDING_CANDIDATES,
    };
  }

  const row = rows[0]!;
  if (row.archived_at !== null) {
    return { status: "unavailable", reason: "repository_archived" };
  }
  await retainExecutableProfile(transaction, row);
  return {
    status: "resolved",
    binding: {
      organizationId: row.organization_id,
      applicationId: row.application_id,
      repositoryId: row.repository_id,
      repositoryProfileId: row.profile_id,
      repositoryProfileRevision: row.profile_revision,
      repositoryProfileDigest: row.profile_digest,
      observationId: row.admitted?.observationId ?? null,
      observationDigest: row.admitted?.observationDigest ?? null,
      baseSha: row.admitted?.baseSha ?? null,
    },
  };
}

/**
 * Resolves distinct authorized repository identities, not execution readiness.
 * A lateral binding lookup deduplicates aliases before the 33-repository probe.
 * Canonically validated strict-v1 or eligible observed-v2 contributes profile pins.
 */
export async function resolveRepositoryBinding(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  input: unknown,
  lockRepository = false,
): Promise<RepositoryBindingResolution> {
  const selector = normalizeRepositoryBindingSelector(input);
  const values: unknown[] = [organizationId, applicationId];
  let source: string;
  let predicate: string;
  if (selector.kind === "repository") {
    source = `
      from bakery.repositories r
      join bakery.applications a
        on a.organization_id = r.organization_id
       and a.id = r.application_id
       and a.archived_at is null
    `;
    values.push(selector.repositoryId);
    predicate =
      "r.organization_id = $1 and r.application_id = $2 and r.id = $3";
  } else {
    source = `
      from bakery.repositories r
      join bakery.applications a
        on a.organization_id = r.organization_id
       and a.id = r.application_id
       and a.archived_at is null`;
    values.push(selector.kind === "role" ? selector.role : selector.aliases);
    predicate = selector.kind === "role"
      ? "b.role = $3"
      : "b.alias = any($3::text[])";
    if (selector.kind === "role" && selector.alias !== null) {
      values.push(selector.alias);
      predicate += " and b.alias = $4";
    } else if (selector.kind === "role") {
      predicate += " and b.alias is null";
    }
    source += `
      join lateral (
        select b.id, b.role, b.alias, b.provenance
          from bakery.repository_role_bindings b
         where b.organization_id = r.organization_id
           and b.application_id = r.application_id
           and b.repository_id = r.id
           and b.archived_at is null
           and ${predicate}
         order by b.id asc
         limit 1
      ) b on true`;
    predicate =
      "r.organization_id = $1 and r.application_id = $2 and r.archived_at is null";
  }
  const result = await transaction.query<BindingRow>(
    `select
        r.organization_id,
        ${selector.kind === "repository" ? "null::uuid" : "b.id"} as binding_id,
        ${
      selector.kind === "repository" ? "null::text" : "b.role"
    } as binding_role,
        ${
      selector.kind === "repository" ? "null::text" : "b.alias"
    } as binding_alias,
        ${
      selector.kind === "repository" ? "null::text" : "b.provenance"
    } as binding_provenance,
        r.id as repository_id,
        r.slug as repository_slug,
        r.application_id,
        r.archived_at,
        p.id as profile_id,
        p.revision as profile_revision,
        p.digest as profile_digest,
        p.config as profile_config,
        r.default_branch
       ${source}
       left join bakery.repository_profiles p
         on p.organization_id = r.organization_id
        and p.application_id = r.application_id
        and p.repository_id = r.id
        and p.id = r.active_profile_id
      where ${predicate}
      order by r.id asc, binding_id asc
      limit ${MAX_REPOSITORY_BINDING_CANDIDATES + 1}
      ${lockRepository ? "for share of r" : ""}`,
    values,
  );
  const resolution = await resolutionFromRows(
    transaction,
    selector,
    result.rows,
  );
  if (
    resolution.status !== "unavailable" ||
    resolution.reason !== "repository_not_found" ||
    selector.kind !== "repository"
  ) {
    return resolution;
  }

  const visible = await transaction.query<{
    organization_id: string;
    application_id: string;
  }>(
    "select organization_id, application_id from bakery.repositories where id = $1",
    [selector.repositoryId],
  );
  if (visible.rows.length === 0) return resolution;
  return { status: "foreign", reason: "repository_scope_mismatch" };
}

export async function resolveExecutableBinding(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  repositoryId: string,
): Promise<ExecutableBinding> {
  const resolution = await resolveRepositoryBinding(
    transaction,
    organizationId,
    applicationId,
    { repositoryId },
    true,
  );
  if (
    resolution.status === "foreign" ||
    (resolution.status === "unavailable" &&
      resolution.reason === "repository_not_found")
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (resolution.status !== "resolved") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: {
        reason: resolution.status === "unavailable"
          ? resolution.reason
          : "ambiguous_repository_binding",
      },
    });
  }
  const binding = resolution.binding;
  if (
    binding.repositoryProfileId === null ||
    binding.repositoryProfileRevision === null ||
    binding.repositoryProfileDigest === null
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "no_active_profile" },
    });
  }
  return {
    repositoryProfileId: binding.repositoryProfileId,
    repositoryProfileRevision: binding.repositoryProfileRevision,
    repositoryProfileDigest: binding.repositoryProfileDigest,
    observationId: binding.observationId,
    observationDigest: binding.observationDigest,
    baseSha: binding.baseSha,
  };
}
