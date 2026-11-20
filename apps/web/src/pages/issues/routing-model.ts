import type {
  TicketRoutingRuleSetResponse,
  TicketRoutingRulesReplace,
} from "../../api/client.ts";

/** The most rules one repository may hold (the server's limit). */
export const MAX_RULES = 50;

/** One row of the rules list as a person edits it. */
export type RuleRow = {
  /** A stable identity for the row while it is edited; not sent to the server. */
  readonly key: string;
  readonly labelId: string;
  readonly labelName: string;
  readonly repositoryId: string;
};

/** What the page knows about a repository a rule may send work to. */
export type RepositoryFacts = Readonly<{
  id: string;
  archived: boolean;
  /** The role the application gives the repository; null when it has none. */
  role: string | null;
}>;

/** The saved rules as rows. */
export function rowsOf(
  set: TicketRoutingRuleSetResponse | undefined,
): RuleRow[] {
  return (set?.rules ?? []).map((rule) => ({
    key: rule.id,
    labelId: rule.labelId,
    labelName: rule.labelName,
    repositoryId: rule.repositoryId,
  }));
}

/** A new, empty row. */
export function emptyRow(): RuleRow {
  return {
    key: crypto.randomUUID(),
    labelId: "",
    labelName: "",
    repositoryId: "",
  };
}

/** Why a row cannot be saved as it is. */
export type RuleProblem = "duplicate" | "archived" | "noRole";

/** The problem of each row that has one, keyed by the row's key. */
export function problemsOf(
  rows: readonly RuleRow[],
  repositories: ReadonlyMap<string, RepositoryFacts>,
): Map<string, RuleProblem> {
  const problems = new Map<string, RuleProblem>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.labelId === "" || row.repositoryId === "") continue;
    const pair = `${row.labelId}\u0000${row.repositoryId}`;
    if (seen.has(pair)) {
      problems.set(row.key, "duplicate");
      continue;
    }
    seen.add(pair);
    const facts = repositories.get(row.repositoryId);
    if (facts === undefined) continue;
    if (facts.archived) problems.set(row.key, "archived");
    else if (facts.role === null) problems.set(row.key, "noRole");
  }
  return problems;
}

const pairOf = (row: Pick<RuleRow, "labelId" | "repositoryId">) =>
  `${row.labelId}\u0000${row.repositoryId}`;

/** Whether the rules differ from the saved ones; order does not matter. */
export function isRulesDirty(
  rows: readonly RuleRow[],
  saved: readonly RuleRow[],
): boolean {
  if (rows.length !== saved.length) return true;
  const wanted = new Set(saved.map(pairOf));
  return rows.some((row) => !wanted.has(pairOf(row)));
}

/** Every row is complete and none has a problem, within the limit. */
export function isRulesSavable(
  rows: readonly RuleRow[],
  problems: ReadonlyMap<string, RuleProblem>,
): boolean {
  return rows.length <= MAX_RULES && problems.size === 0 &&
    rows.every((row) => row.labelId !== "" && row.repositoryId !== "");
}

/** The request that replaces the whole list; the role is the repository's. */
export function ruleSetOf(
  rows: readonly RuleRow[],
  repositories: ReadonlyMap<string, RepositoryFacts>,
): TicketRoutingRulesReplace {
  return {
    rules: rows.map((row) => ({
      labelId: row.labelId,
      labelName: row.labelName,
      repositoryId: row.repositoryId,
      role: repositories.get(row.repositoryId)?.role ?? "",
    })),
  };
}

/** The reasons a server refusal of the rules can state, by its stable issue code. */
export type RuleRefusal = "duplicate" | "unavailable" | "unbound";

export function refusalOf(
  issueCodes: readonly string[] | undefined,
): RuleRefusal | null {
  const codes = issueCodes ?? [];
  if (codes.includes("routing_rule_duplicate")) return "duplicate";
  if (codes.includes("routing_repository_unavailable")) return "unavailable";
  if (codes.includes("routing_role_unbound")) return "unbound";
  return null;
}
