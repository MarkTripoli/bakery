import type { ReactNode } from "react";
import "../data.css";

export type DataTableColumn<Row> = {
  cell: (row: Row) => ReactNode;
  header: ReactNode;
  id: string;
  sortable?: boolean;
  /** `ruled` layout: the column's width as a CSS length; one column may omit it. */
  width?: string;
  /** `ruled` layout: align the column's content to the end. */
  align?: "start" | "end";
};
export type DataTableProps<Row> = {
  caption: string;
  columns: DataTableColumn<Row>[];
  emptyMessage?: ReactNode;
  error?: ReactNode;
  getRowKey: (row: Row) => string;
  /** Extra `data-*` attributes for a row, such as an id a test can find. */
  getRowAttributes?: (row: Row) => Record<`data-${string}`, string>;
  onSort?: (id: string) => void;
  rows: Row[];
  sort?: { direction: "ascending" | "descending"; id: string };
  state?:
    | "loading"
    | "empty"
    | "ready"
    | "error"
    | "sorting"
    | "stale"
    | "long-content";
  /**
   * `ruled` is the p-18-0 plan and onboarding table: fixed columns, quiet
   * 12px headers on a 36px ruled row, 14px/12px body rows.
   */
  variant?: "table" | "sheetList" | "ruled";
  /**
   * `ruled` only: `page` adds the 32px page inset around the table, `edge`
   * runs the rules full width with a 24px cell inset. A row that returns
   * `data-selected="true"` from `getRowAttributes` is tinted.
   */
  inset?: "none" | "page" | "edge";
  /** `ruled` + `edge`: `double` rows hold two text lines (60px), `single` one (52px). */
  rowSize?: "single" | "double";
  /**
   * `ruled` only: makes the first cell of every row a button that calls this
   * with the row; the row whose key equals `selectedRowKey` is marked.
   */
  onSelectRow?: (row: Row) => void;
  selectedRowKey?: string | null;
};

export function DataTable<Row>(
  {
    caption,
    columns,
    emptyMessage = "No results.",
    error,
    getRowAttributes,
    getRowKey,
    onSort,
    rows,
    inset = "none",
    onSelectRow,
    rowSize = "single",
    selectedRowKey = null,
    sort,
    state = "ready",
    variant = "table",
  }: DataTableProps<Row>,
) {
  if (state === "error") {
    return (
      <div
        className={`ui-data-table ui-data-table--${variant}`}
        data-state={state}
        data-variant={variant}
        data-ui-component="dataTable"
      >
        <p role="alert">{error ?? "Unable to load results."}</p>
      </div>
    );
  }
  return (
    <div
      aria-label={caption}
      className={`ui-data-table ui-data-table--${variant}`}
      data-inset={variant === "ruled" ? inset : undefined}
      data-rows={variant === "ruled" ? rowSize : undefined}
      data-state={state}
      data-variant={variant}
      data-ui-component="dataTable"
      tabIndex={0}
    >
      {state === "stale"
        ? (
          <p className="ui-data-table__state" role="status">
            Showing stale results.
          </p>
        )
        : null}
      <table
        aria-busy={state === "loading" || state === "sorting" || undefined}
      >
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                aria-sort={sort?.id === column.id ? sort.direction : undefined}
                data-align={column.align}
                key={column.id}
                style={variant === "ruled"
                  ? { width: column.width }
                  : undefined}
                scope="col"
              >
                {column.sortable
                  ? (
                    <button onClick={() => onSort?.(column.id)} type="button">
                      {column.header}
                    </button>
                  )
                  : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state === "loading"
            ? (
              <tr>
                <td colSpan={columns.length}>Loading…</td>
              </tr>
            )
            : rows.length
            ? rows.map((row) => (
              <tr
                key={getRowKey(row)}
                {...getRowAttributes?.(row)}
                data-selected={selectedRowKey === getRowKey(row)
                  ? "true"
                  : getRowAttributes?.(row)["data-selected"]}
              >
                {columns.map((column, index) => (
                  <td data-align={column.align} key={column.id}>
                    {index === 0 && onSelectRow
                      ? (
                        <button
                          aria-pressed={selectedRowKey === getRowKey(row)}
                          className="ui-data-table__select"
                          onClick={() => onSelectRow(row)}
                          type="button"
                        >
                          {column.cell(row)}
                        </button>
                      )
                      : column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
            : (
              <tr>
                <td colSpan={columns.length}>{emptyMessage}</td>
              </tr>
            )}
        </tbody>
      </table>
    </div>
  );
}
