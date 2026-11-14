import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";

/** One row of a Library list: a name, one line under it, a badge and a short note. */
export type LibraryRow = {
  readonly id: string;
  readonly name: string;
  /** One line under the name: what it is for, or that it has no description. */
  readonly line: string;
  readonly badge: string;
  readonly tone: "neutral" | "success" | "warning";
  /** Short facts after the badge, such as "Version 2 · 3 steps". */
  readonly note: string;
};

/**
 * The rows of one Library section: a ruled table on a wide screen, stacked
 * rows on a phone. Rows carry no button yet; opening one comes with the
 * workflow and agent pages.
 */
export function LibraryRows(
  { label, phone, rows, translate }: {
    readonly label: string;
    readonly phone: boolean;
    readonly rows: readonly LibraryRow[];
    readonly translate: Translator;
  },
) {
  if (phone) {
    return (
      <UI.Stack gap="none" role="list" aria-label={label}>
        {rows.map((row) => (
          <div key={row.id} role="listitem" data-library-id={row.id}>
            <UI.StackedRow
              title={row.name}
              status={<UI.Badge tone={row.tone}>{row.badge}</UI.Badge>}
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
  return (
    <UI.DataTable<LibraryRow>
      caption={label}
      captionHidden
      headingsHidden
      variant="ruled"
      inset="edge"
      rowSize="double"
      rows={[...rows]}
      state="ready"
      getRowKey={(row) => row.id}
      getRowAttributes={(row) => ({ "data-library-id": row.id })}
      columns={[
        {
          id: "name",
          width: "56%",
          header: translate("library.column.name" as never),
          cell: (row) => <UI.CellStack title={row.name} detail={row.line} />,
        },
        {
          id: "status",
          header: translate("library.column.status" as never),
          cell: (row) => <UI.Badge tone={row.tone}>{row.badge}</UI.Badge>,
        },
        {
          id: "note",
          align: "end",
          header: translate("library.column.status" as never),
          cell: (row) => <UI.Text variant="caption">{row.note}</UI.Text>,
        },
      ]}
    />
  );
}
