import type { ReactNode } from "react";
import { useState } from "react";
import "../data.css";

export type CommandItem = {
  disabled?: boolean;
  id: string;
  label: ReactNode;
  searchText?: string;
};
export type CommandProps = {
  emptyMessage?: ReactNode;
  inputLabel: string;
  items: CommandItem[];
  onRun?: (id: string) => void;
  onQueryChange?: (query: string) => void;
  open?: boolean;
  query?: string;
  scope?: ReactNode;
  variant?: "global" | "scoped";
};

export function Command(
  {
    emptyMessage = "No commands found.",
    inputLabel,
    items,
    onRun,
    onQueryChange,
    open = true,
    query,
    scope,
    variant = "global",
  }: CommandProps,
) {
  const [internalSearch, setInternalSearch] = useState("");
  const [focusWithin, setFocusWithin] = useState(false);
  const search = query ?? internalSearch;
  const visibleItems = search
    ? items.filter((item) =>
      (item.searchText ??
        (typeof item.label === "string" ? item.label : item.id))
        .toLocaleLowerCase().includes(search.toLocaleLowerCase())
    )
    : items;
  const resolvedState = focusWithin
    ? "focused"
    : visibleItems.length === 0
    ? "empty"
    : search
    ? "searching"
    : "open";
  if (!open) {
    return (
      <section
        aria-hidden="true"
        className={`ui-command ui-command--${variant}`}
        data-state="closed"
        data-variant={variant}
        data-ui-component="command"
        hidden
      />
    );
  }
  return (
    <section
      aria-label={scope ? `${scope} commands` : "Commands"}
      className={`ui-command ui-command--${variant}`}
      data-state={resolvedState}
      data-variant={variant}
      data-ui-component="command"
      role="dialog"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setFocusWithin(false);
        }
      }}
      onFocusCapture={() => setFocusWithin(true)}
    >
      <label>
        {inputLabel}
        <input
          aria-label={inputLabel}
          autoComplete="off"
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (query === undefined) setInternalSearch(next);
            onQueryChange?.(next);
          }}
          type="search"
          value={search}
        />
      </label>
      {scope ? <p className="ui-command__scope">{scope}</p> : null}
      <ul>
        {visibleItems.length
          ? visibleItems.map((item) => (
            <li key={item.id}>
              <button
                disabled={item.disabled}
                onClick={() => onRun?.(item.id)}
                type="button"
              >
                {item.label}
              </button>
            </li>
          ))
          : <li>{emptyMessage}</li>}
      </ul>
    </section>
  );
}
