import type { Translator } from "@bakery/i18n";
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
  /** Present when the row has a page to open (the organization's workflows). */
  readonly openLabel?: string;
};

/**
 * The rows of one Library section. A row that has a page to open carries an
 * Open button.
 */
export function LibraryRows(
  { label, onOpen, rows, translate }: {
    readonly label: string;
    readonly onOpen?: (row: LibraryRow) => void;
    readonly rows: readonly LibraryRow[];
    readonly translate: Translator;
  },
) {
  const openButton = (row: LibraryRow) =>
    row.openLabel === undefined || onOpen === undefined ? null : (
      <UI.Button
        variant="secondary"
        aria-label={row.openLabel}
        onClick={() => onOpen(row)}
      >
        {translate("library.workflow.open" as never)}
      </UI.Button>
    );
  // One list at every width: a name and its badge, the line under it, the
  // note and the button. (A table with its headings repeats them under each
  // section.)
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
            {openButton(row)}
          </UI.StackedRow>
        </div>
      ))}
    </UI.Stack>
  );
}
