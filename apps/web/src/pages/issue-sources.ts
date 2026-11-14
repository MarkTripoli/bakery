import type {
  IntegrationResource,
  RepositoryResponse,
  TicketSourceResponse,
} from "../api/client.ts";

/** A repository Bakery works in, with the GitHub resource behind it and the source of issues, if any. */
export type SourceRow = {
  readonly repository: RepositoryResponse;
  /** The connection's selected, available resource; null when the connection does not offer it. */
  readonly resource: IntegrationResource | null;
  readonly source: TicketSourceResponse | null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The label names the sheet starts with the first time a repository is turned on. */
export const DEFAULT_START_LABEL = "bakery";
export const DEFAULT_HOLD_LABEL = "hold";

/**
 * The repositories (not archived) in name order, each with its resource
 * (same connection and GitHub id, selected and available) and its source.
 */
export function sourceRows(
  repositories: readonly RepositoryResponse[],
  resources: readonly IntegrationResource[],
  sources: readonly TicketSourceResponse[],
): SourceRow[] {
  const byKey = new Map(
    resources.filter((resource) => resource.selected && resource.available)
      .map((resource) => [
        `${resource.connectionId}\n${resource.externalId}`,
        resource,
      ]),
  );
  return repositories.filter((repository) => repository.archivedAt === null)
    .map((repository) => {
      const resource = byKey.get(
        `${repository.integrationConnectionId}\n${repository.providerRepoId}`,
      ) ?? null;
      const source = sources.find((candidate) =>
        candidate.repositoryId === repository.id ||
        (resource !== null && candidate.integrationResourceId === resource.id)
      ) ?? null;
      return { repository, resource, source };
    })
    .sort((a, b) =>
      `${a.repository.owner}/${a.repository.name}`.localeCompare(
        `${b.repository.owner}/${b.repository.name}`,
      )
    );
}

/** What a row says now: on or off, and the two labels. */
export type SourceDraft = {
  readonly enabled: boolean;
  readonly start: string;
  readonly hold: string;
};

/** The saved state of a row, or the defaults for a repository that never took issues. */
export function draftOf(row: SourceRow): SourceDraft {
  if (row.source === null) {
    return {
      enabled: false,
      start: DEFAULT_START_LABEL,
      hold: DEFAULT_HOLD_LABEL,
    };
  }
  const labels = record(record(row.source.policy).labels);
  return {
    enabled: row.source.enabled,
    start: text(labels.execute) || DEFAULT_START_LABEL,
    hold: text(labels.hold) || DEFAULT_HOLD_LABEL,
  };
}

export type DraftErrors = {
  readonly start?: "empty";
  readonly hold?: "empty";
  /** Both labels are the same, ignoring case: GitHub labels are not case-sensitive. */
  readonly same?: true;
};

/** What is wrong with the labels of a row that is on. A row that is off needs none. */
export function draftErrors(draft: SourceDraft): DraftErrors {
  if (!draft.enabled) return {};
  const start = draft.start.trim();
  const hold = draft.hold.trim();
  return {
    ...(start === "" ? { start: "empty" as const } : {}),
    ...(hold === "" ? { hold: "empty" as const } : {}),
    ...(start !== "" && hold !== "" &&
        start.toLowerCase() === hold.toLowerCase()
      ? { same: true as const }
      : {}),
  };
}

/** Whether the person changed anything about the row. */
export function isDirty(row: SourceRow, draft: SourceDraft): boolean {
  const saved = draftOf(row);
  if (row.source === null) return draft.enabled;
  return saved.enabled !== draft.enabled ||
    (draft.enabled &&
      (saved.start !== draft.start.trim() || saved.hold !== draft.hold.trim()));
}

/** One thing Save does: start taking issues from a repository, or change what it already takes. */
export type SourceChange =
  | {
    readonly kind: "create";
    readonly row: SourceRow;
    readonly draft: SourceDraft;
  }
  | {
    readonly kind: "update";
    readonly row: SourceRow;
    readonly source: TicketSourceResponse;
    readonly draft: SourceDraft;
  };

/** The changes Save makes: only rows that changed, and only ones that can be made. */
export function changesOf(
  rows: readonly SourceRow[],
  drafts: ReadonlyMap<string, SourceDraft>,
): SourceChange[] {
  return rows.flatMap((row): SourceChange[] => {
    const draft = drafts.get(row.repository.id) ?? draftOf(row);
    if (!isDirty(row, draft)) return [];
    if (row.source === null) {
      return row.resource === null ? [] : [{ kind: "create", row, draft }];
    }
    return [{ kind: "update", row, source: row.source, draft }];
  });
}

/**
 * The policy to send: the two labels from the sheet, and everything else as it
 * is (a new source gets the defaults: acceptance criteria required, a person
 * approves the plan, no planning-only label, automatic start off).
 */
/** The policy document as it is sent: the labels from the sheet and the rest kept. */
export type SourcePolicy = {
  readonly version: 1;
  readonly labels: {
    readonly execute: string;
    readonly planOnly: string | null;
    readonly hold: string;
  };
  readonly delegation: unknown;
  readonly automatic: { readonly enabled: boolean };
  readonly readiness: unknown;
  readonly approval: unknown;
  readonly preset: "fixed-coding";
};

export function policyOf(draft: SourceDraft, existing: unknown): SourcePolicy {
  const current = record(existing);
  const labels = record(current.labels);
  const readiness = record(current.readiness);
  const approval = record(current.approval);
  return {
    version: 1 as const,
    labels: {
      execute: draft.start.trim(),
      planOnly: typeof labels.planOnly === "string" ? labels.planOnly : null,
      hold: draft.hold.trim(),
    },
    delegation: current.delegation ?? null,
    automatic: { enabled: record(current.automatic).enabled === true },
    readiness: Object.keys(readiness).length > 0
      ? readiness
      : { requireAcceptanceCriteria: true },
    approval: Object.keys(approval).length > 0
      ? approval
      : { plan: "human_approval" as const },
    preset: "fixed-coding" as const,
  };
}
