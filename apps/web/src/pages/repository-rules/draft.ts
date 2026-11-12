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
  /** The rules as that revision published them, to tell "also changed there" from "only changed here". */
  readonly baseEntries: readonly RuleEntry[];
  /** Each edited or added rule as the administrator left it, by rule key. */
  readonly edited: Readonly<Partial<Record<RuleKey, RuleEntry>>>;
  /** Rules edited here that someone else changed too, waiting for a decision. */
  readonly conflicts: readonly RuleKey[];
  /** The revision published while this draft was open, until the notice is dismissed. */
  readonly staleRevision: number | null;
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

/**
 * The draft moved onto a newer published revision. An edit to a rule nobody
 * else touched carries over as it was; an edit to a rule changed in both
 * places becomes a conflict to decide; an edit that now says what the new
 * revision says is dropped, as there is nothing left to publish.
 */
export function rebaseDraft(
  draft: RulesDraft,
  revision: number,
  entries: readonly RuleEntry[],
): RulesDraft | null {
  const edited: Partial<Record<RuleKey, RuleEntry>> = {};
  const conflicts: RuleKey[] = [];
  for (const key of RULE_KEYS) {
    const mine = draft.edited[key];
    if (!mine) continue;
    const base = draft.baseEntries.find((entry) => entry.ruleKey === key);
    const theirs = entries.find((entry) => entry.ruleKey === key);
    if (theirs && sameEntry(mine, theirs)) continue;
    edited[key] = mine;
    const changedThere = base && theirs
      ? !sameEntry(base, theirs)
      : Boolean(base) !== Boolean(theirs);
    if (changedThere) conflicts.push(key);
  }
  if (Object.keys(edited).length === 0) return null;
  return {
    baseRevision: revision,
    baseEntries: entries,
    edited,
    conflicts,
    staleRevision: revision,
  };
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
  const update = (change: (current: RulesDraft | null) => RulesDraft | null) =>
    queryClient.setQueryData<RulesDraft | null>(
      queryKey,
      (current) => change(current ?? null),
    );

  /** Puts an entry into the draft, or takes it out again when it matches the published one. */
  const apply = (entry: RuleEntry) => {
    update((current) => {
      const next: RulesDraft = {
        baseRevision: current?.baseRevision ?? revision ?? 0,
        baseEntries: current?.baseEntries ?? published ?? [],
        edited: { ...(current?.edited ?? {}), [entry.ruleKey]: entry },
        // Editing a rule again is deciding it: it stays as the person left it.
        conflicts: (current?.conflicts ?? []).filter((key) =>
          key !== entry.ruleKey
        ),
        staleRevision: current?.staleRevision ?? null,
      };
      return changedKeys(published ?? [], next).length === 0 ? null : next;
    });
  };
  const discard = () => update(() => null);
  /** Moves the draft onto a newer published revision (see `rebaseDraft`). */
  const rebase = (newRevision: number, entries: readonly RuleEntry[]) =>
    update((current) =>
      current && current.baseRevision !== newRevision
        ? rebaseDraft(current, newRevision, entries)
        : current
    );
  /** Decides one conflict: the other revision's rule, or the one edited here. */
  const resolve = (key: RuleKey, keep: "theirs" | "mine") =>
    update((current) => {
      if (!current) return current;
      const edited = { ...current.edited };
      if (keep === "theirs") delete edited[key];
      if (Object.keys(edited).length === 0) return null;
      return {
        ...current,
        edited,
        conflicts: current.conflicts.filter((other) => other !== key),
      };
    });
  /** Dismisses the notice that a newer revision was published. */
  const acknowledge = () =>
    update((current) => current && { ...current, staleRevision: null });

  return {
    acknowledge,
    apply,
    changed,
    conflicts: draft?.conflicts ?? [],
    count: changed.length,
    discard,
    draft,
    entries: published ? effectiveEntries(published, draft) : [],
    rebase,
    resolve,
  };
}
