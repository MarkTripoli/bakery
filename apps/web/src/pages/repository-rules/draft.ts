import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProtectedScope } from "../../app/query-scope.ts";
import { protectedQueryKey } from "../../app/query-scope.ts";
import { RULE_KEYS, type RuleEntry, type RuleKey } from "./presentation.ts";

/**
 * Edits to the organization's rules that are not published yet. The draft is
 * page state for the session: it is kept while a person moves between the
 * rules list and a rule's editor, it is never stored on the server, and it is
 * dropped with every other protected query when the session or organization
 * changes.
 */
export type RulesDraft = {
  /** The published revision the edits were made against. */
  readonly baseRevision: number;
  /** Each edited or added rule as the administrator left it, by rule key. */
  readonly edited: Readonly<Partial<Record<RuleKey, RuleEntry>>>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stable(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/** Whether two entries say exactly the same thing. */
export function sameEntry(a: RuleEntry, b: RuleEntry): boolean {
  return stable(a) === stable(b);
}

/** The rule keys the draft changes: an added rule, or one that differs from the published entry. */
export function changedKeys(
  published: readonly RuleEntry[],
  draft: RulesDraft | null,
): RuleKey[] {
  if (!draft) return [];
  return RULE_KEYS.filter((key) => {
    const edited = draft.edited[key];
    if (!edited) return false;
    const current = published.find((entry) => entry.ruleKey === key);
    return !current || !sameEntry(current, edited);
  });
}

/** The rules as they would be once the draft is published, in the usual order. */
export function effectiveEntries(
  published: readonly RuleEntry[],
  draft: RulesDraft | null,
): RuleEntry[] {
  return RULE_KEYS.flatMap((key) => {
    const entry = draft?.edited[key] ??
      published.find((candidate) => candidate.ruleKey === key);
    return entry ? [entry] : [];
  });
}

/** The draft of the organization the scope names, and the ways to change it. */
export function useRulesDraft(
  scope: ProtectedScope,
  revision: number | undefined,
  published: readonly RuleEntry[] | undefined,
) {
  const queryClient = useQueryClient();
  const queryKey = protectedQueryKey(scope, "repositoryRules.draft", {});
  const query = useQuery<RulesDraft | null>({
    queryKey,
    queryFn: () => null,
    initialData: null,
    staleTime: Infinity,
    gcTime: Infinity,
    networkMode: "always",
  });
  const draft = query.data ?? null;
  const changed = published ? changedKeys(published, draft) : [];

  /** Puts an entry into the draft, or takes it out again when it matches the published one. */
  const apply = (entry: RuleEntry) => {
    queryClient.setQueryData<RulesDraft | null>(queryKey, (current) => {
      const edited = { ...(current?.edited ?? {}), [entry.ruleKey]: entry };
      const next: RulesDraft = {
        baseRevision: current?.baseRevision ?? revision ?? 0,
        edited,
      };
      return changedKeys(published ?? [], next).length === 0 ? null : next;
    });
  };
  const discard = () =>
    queryClient.setQueryData<RulesDraft | null>(queryKey, null);

  return {
    apply,
    changed,
    count: changed.length,
    discard,
    draft,
    entries: published ? effectiveEntries(published, draft) : [],
  };
}
