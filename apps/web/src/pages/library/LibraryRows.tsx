import * as UI from "@bakery/ui";

/** One row of a Library list: a name, one line under it, a badge and a short note. */
export type LibraryRow = {
  readonly id: string;
  readonly name: string;
  /** One line under the name: what it is for, or that it has no description. */
  readonly line: string;
  /** The row's one badge; null when the section heading already says it (Built in). */
  readonly badge: string | null;
  readonly tone: "neutral" | "success" | "warning";
  /** Short facts after the badge, such as "Version 2 · 3 steps". */
  readonly note: string;
};

/**
 * The rows of one Library section. Rows carry no button yet; opening one
 * comes with the workflow and agent pages.
 */
export function LibraryRows(
  { label, rows }: {
    readonly label: string;
    readonly rows: readonly LibraryRow[];
  },
) {
  // One list at every width: a name and its badge, the line under it and the
  // note. (A table with its headings repeats them under each section.)
  return (
    <UI.Stack gap="none" role="list" aria-label={label}>
      {rows.map((row) => (
        <div key={row.id} role="listitem" data-library-id={row.id}>
          <UI.StackedRow
            flush
            title={row.name}
            status={row.badge === null
              ? undefined
              : <UI.Badge tone={row.tone}>{row.badge}</UI.Badge>}
          >
            <UI.Text variant="caption">{row.line}</UI.Text>
            {row.note !== ""
              ? <UI.Text variant="caption">{row.note}</UI.Text>
              : null}
          </UI.StackedRow>
        </div>
      ))}
    </UI.Stack>
  );
}
