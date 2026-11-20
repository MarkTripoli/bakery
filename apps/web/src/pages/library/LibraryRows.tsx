import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../../app/responsive.ts";

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
  /** Present when the name links to the row's page (a built-in workflow). */
  readonly href?: string;
  /** Present when the row can be copied (a built-in workflow, for an administrator). */
  readonly copyLabel?: string;
  /** The open button's visible words when they are not "Open" (a suggested fact says "Review"). */
  readonly openText?: string;
  /** The open button is the row's one primary action (a fact waiting for review). */
  readonly primary?: boolean;
  /** The row is quiet: its name is muted (a fact no longer used). */
  readonly muted?: boolean;
  /** The row is the one whose detail is open beside the list. */
  readonly selected?: boolean;
};

/**
 * The rows of one Library section. A row that has a page to open carries an
 * Open button.
 */
export function LibraryRows(
  { label, onCopy, onNavigate, onOpen, rows, translate }: {
    readonly label: string;
    readonly onCopy?: (row: LibraryRow) => void;
    readonly onNavigate?: (href: string) => void;
    readonly onOpen?: (row: LibraryRow) => void;
    readonly rows: readonly LibraryRow[];
    readonly translate: Translator;
  },
) {
  // On a wide screen a row's button sits at the end of the name's line, at
  // its label's width; on a phone it spans the row under the text.
  const phone = useShellViewport() === "phone";
  const openButton = (row: LibraryRow) =>
    row.openLabel === undefined || onOpen === undefined ? null : (
      <UI.Button
        variant={row.primary === true ? "primary" : "secondary"}
        aria-label={row.openLabel}
        onClick={() => onOpen(row)}
      >
        {row.openText ?? translate("library.workflow.open" as never)}
      </UI.Button>
    );
  const copyButton = (row: LibraryRow) =>
    row.copyLabel === undefined || onCopy === undefined ? null : (
      <UI.Button
        variant="secondary"
        aria-label={row.copyLabel}
        onClick={() => onCopy(row)}
      >
        {translate("library.workflow.makeCopy" as never)}
      </UI.Button>
    );
  const title = (row: LibraryRow) =>
    row.href === undefined || onNavigate === undefined
      ? row.muted === true
        ? <UI.Text variant="muted">{row.name}</UI.Text>
        : row.name
      : (
        <UI.Link
          href={row.href}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(row.href as string);
          }}
        >
          {row.name}
        </UI.Link>
      );
  // One list at every width: a name and its badge, the line under it, the
  // note and the button. (A table with its headings repeats them under each
  // section.)
  return (
    <UI.Stack gap="none" role="list" aria-label={label}>
      {rows.map((row) => {
        const badge = row.badge === null
          ? null
          : <UI.Badge tone={row.tone}>{row.badge}</UI.Badge>;
        const buttons = (
          <>
            {openButton(row)}
            {copyButton(row)}
          </>
        );
        const hasButton = row.openLabel !== undefined ||
          row.copyLabel !== undefined;
        return (
          <div
            key={row.id}
            role="listitem"
            data-library-id={row.id}
            aria-current={row.selected === true ? "true" : undefined}
          >
            <UI.StackedRow
              flush
              selected={row.selected === true}
              title={title(row)}
              status={phone || !hasButton
                ? badge ?? undefined
                : (
                  <UI.Inline gap="compact">
                    {badge}
                    {buttons}
                  </UI.Inline>
                )}
            >
              <UI.Text variant="caption">{row.line}</UI.Text>
              {row.note !== ""
                ? <UI.Text variant="caption">{row.note}</UI.Text>
                : null}
              {phone ? buttons : null}
            </UI.StackedRow>
          </div>
        );
      })}
    </UI.Stack>
  );
}
