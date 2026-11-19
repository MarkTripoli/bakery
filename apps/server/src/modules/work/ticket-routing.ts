import {
  TICKET_ROUTE_FALLBACK_ROLE,
  type TicketRouteBlockReason,
} from "@bakery/contracts/ticket-admission";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Label routing (#31): which repositories one ticket targets. A source's rules
 * map provider label ids to repositories in roles; a ticket targets the union
 * of the rules its label ids match, one target per repository. Matching is by
 * the provider's stable label id, so renaming a label keeps its routing; the
 * name is display only. With no matching rule the ticket falls back to the
 * source's own repository, as it did before routing existed. A match that
 * cannot be honoured (an archived or inaccessible target, or an ambiguous
 * role) blocks the ticket with a named reason; it is never dropped from the
 * union or routed somewhere else.
 *
 * Each routed target runs as a child task of a ticket-origin coordination
 * plan, through the application's repository role binding (its alias names
 * the repository to the plan). A target whose role binding is gone is
 * inaccessible.
 *
 * The resolution is pure. Admission reads the rules under the source lock,
 * resolves once, lets readiness report the outcome and pins the targets of a
 * ticket it admits. A request that exists is never resolved again.
 */

/** One rule of a source with the live state of the repository it routes to. */
export type TicketRouteRule = {
  id: string;
  labelId: string;
  labelName: string;
  repositoryId: string;
  role: string;
  presetId: string;
  version: number;
  /** The repository is archived. */
  repositoryArchived: boolean;
  /**
   * The repository still belongs to the source's application, its connection
   * is live, and a live role binding gives it an alias for the plan.
   */
  repositoryAccessible: boolean;
  /** Alias of the application's role binding for (repository, role), or null. */
  alias: string | null;
};

/** One repository a ticket is routed to. */
export type TicketRouteTarget = {
  repositoryId: string;
  role: string;
  /** The rule that routed here, or null for the fallback to the source's repository. */
  ruleId: string | null;
  ruleVersion: number | null;
  /**
   * The rule's preset, or null for the fallback, which runs the request's own
   * pinned preset as before routing.
   */
  presetId: string | null;
  /** Role binding alias the coordination lane names; null for the fallback. */
  alias: string | null;
};

/** Routed targets whose repository cannot run the preset yet, as evidence refs. */
export type TicketRouteUnready = { profile: string[]; preset: string[] };

export type TicketRouteResolution =
  | {
    kind: "routed";
    /** One per repository, ordered by role then repository id. */
    targets: TicketRouteTarget[];
    /** True when rules exist but none matched, so the source's repository was used. */
    fallback: boolean;
    /** Filled by admission: routed targets with no ready profile or preset. */
    unready?: TicketRouteUnready;
  }
  | {
    kind: "blocked";
    reason: TicketRouteBlockReason;
    /** Stable references to what blocked it, such as `label:backend`. */
    refs: string[];
  };

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Resolves the targets of a ticket carrying the provider label ids
 * `labelIds`. Null means the read named its labels without ids: with rules,
 * the router cannot tell which apply, so the ticket is blocked as ambiguous
 * rather than silently falling back. `fallbackRepositoryId` is the source's
 * own repository; null leaves an unmatched ticket with no target, which
 * repository readiness already refuses.
 */
export function resolveTicketRoutes(
  labelIds: readonly string[] | null,
  rules: readonly TicketRouteRule[],
  fallbackRepositoryId: string | null,
): TicketRouteResolution {
  if (labelIds === null && rules.length > 0) {
    return {
      kind: "blocked",
      reason: "route_ambiguous",
      refs: ["labels:unidentified"],
    };
  }
  const carried = new Set(labelIds ?? []);
  const matched = rules.filter((rule) => carried.has(rule.labelId)).sort((
    left,
    right,
  ) =>
    byText(left.labelId, right.labelId) ||
    byText(left.repositoryId, right.repositoryId)
  );
  if (matched.length === 0) {
    return {
      kind: "routed",
      targets: fallbackRepositoryId === null ? [] : [{
        repositoryId: fallbackRepositoryId,
        role: TICKET_ROUTE_FALLBACK_ROLE,
        ruleId: null,
        ruleVersion: null,
        presetId: null,
        alias: null,
      }],
      fallback: rules.length > 0,
    };
  }
  const ref = (rule: TicketRouteRule) => `label:${rule.labelName}`;
  const deleted = matched.filter((rule) => rule.repositoryArchived);
  if (deleted.length > 0) {
    return {
      kind: "blocked",
      reason: "route_target_deleted",
      refs: deleted.map(ref),
    };
  }
  const inaccessible = matched.filter((rule) =>
    !rule.repositoryAccessible || rule.alias === null
  );
  if (inaccessible.length > 0) {
    return {
      kind: "blocked",
      reason: "route_target_inaccessible",
      refs: inaccessible.map(ref),
    };
  }
  const byRepository = new Map<string, TicketRouteRule[]>();
  const byRole = new Map<string, Set<string>>();
  for (const rule of matched) {
    byRepository.set(rule.repositoryId, [
      ...(byRepository.get(rule.repositoryId) ?? []),
      rule,
    ]);
    byRole.set(
      rule.role,
      (byRole.get(rule.role) ?? new Set()).add(rule.repositoryId),
    );
  }
  const ambiguous: string[] = [];
  for (const [role, repositories] of byRole) {
    if (repositories.size > 1) ambiguous.push(`role:${role}`);
  }
  for (const group of byRepository.values()) {
    const first = group[0];
    if (
      group.some((rule) =>
        rule.role !== first.role || rule.presetId !== first.presetId
      )
    ) {
      ambiguous.push(...group.map(ref));
    }
  }
  if (ambiguous.length > 0) {
    return { kind: "blocked", reason: "route_ambiguous", refs: ambiguous };
  }
  // The union, one target per repository: labels that agree on a repository's
  // role and preset collapse into the first rule (by label id).
  const targets = [...byRepository.values()].map((group) => ({
    repositoryId: group[0].repositoryId,
    role: group[0].role,
    ruleId: group[0].id,
    ruleVersion: group[0].version,
    presetId: group[0].presetId,
    alias: group[0].alias,
  })).sort((left, right) =>
    byText(left.role, right.role) ||
    byText(left.repositoryId, right.repositoryId)
  );
  return { kind: "routed", targets, fallback: false };
}

type RuleRow = {
  id: string;
  provider_label_id: string;
  label_name: string;
  repository_id: string;
  role: string;
  preset_id: string;
  version: number;
  repository_archived: boolean;
  repository_accessible: boolean;
  alias: string | null;
};

/**
 * The rules of one source with their repositories' live state and role
 * binding aliases. The caller holds the source row, so a concurrent rule
 * replacement (which takes it `for update`) waits for this transaction.
 */
export async function readRouteRules(
  transaction: PgTransactionClient,
  // A provider-neutral source may name no application (0206). The rule query
  // then compares against null and matches nothing, which is the right answer:
  // no rule can claim a source that has no application to claim it by.
  source: {
    organizationId: string;
    id: string;
    applicationId: string | null;
  },
): Promise<TicketRouteRule[]> {
  const result = await transaction.query<RuleRow>(
    `select rule.id, rule.provider_label_id, rule.label_name,
            rule.repository_id, rule.role, rule.preset_id, rule.version,
            repository.archived_at is not null as repository_archived,
            (repository.application_id = $3
              and connection.archived_at is null) as repository_accessible,
            (select min(binding.alias)
               from bakery.repository_role_bindings as binding
              where binding.organization_id = rule.organization_id
                and binding.application_id = $3
                and binding.repository_id = rule.repository_id
                and binding.role = rule.role
                and binding.alias is not null
                and binding.archived_at is null) as alias
       from bakery.ticket_routing_rules as rule
       join bakery.repositories as repository
         on repository.organization_id = rule.organization_id
        and repository.id = rule.repository_id
       left join bakery.integration_connections as connection
         on connection.organization_id = repository.organization_id
        and connection.id = repository.integration_connection_id
      where rule.organization_id = $1 and rule.ticket_source_id = $2
      order by rule.provider_label_id, rule.repository_id`,
    [source.organizationId, source.id, source.applicationId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    labelId: row.provider_label_id,
    labelName: row.label_name,
    repositoryId: row.repository_id,
    role: row.role,
    presetId: row.preset_id,
    version: row.version,
    repositoryArchived: row.repository_archived,
    // A repository with no connection row predates connections and stays
    // accessible; the left join reads its archive test as null-safe true.
    repositoryAccessible: row.repository_accessible === true,
    alias: row.alias,
  }));
}
