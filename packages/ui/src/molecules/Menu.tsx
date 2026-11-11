import type { ReactNode } from "react";
import { useState } from "react";
import "../data.css";

export type MenuItem = {
  disabled?: boolean;
  href?: string;
  id: string;
  label: ReactNode;
  selected?: boolean;
};
export type MenuProps = {
  "aria-label": string;
  items: MenuItem[];
  onSelect?: (id: string) => void;
  open?: boolean;
  variant?: "action" | "selection";
};

export function Menu(
  {
    "aria-label": ariaLabel,
    items,
    onSelect,
    open = true,
    variant = "action",
  }: MenuProps,
) {
  const [focusWithin, setFocusWithin] = useState(false);
  const allDisabled = items.length > 0 && items.every((item) => item.disabled);
  const resolvedState = allDisabled
    ? "disabled"
    : focusWithin
    ? "focused"
    : "open";
  if (!open) {
    return (
      <nav
        aria-hidden="true"
        className={`ui-menu ui-menu--${variant}`}
        data-state="closed"
        data-variant={variant}
        data-ui-component="menu"
        hidden
      />
    );
  }
  return (
    <nav
      aria-label={ariaLabel}
      className={`ui-menu ui-menu--${variant}`}
      data-state={resolvedState}
      data-ui-component="menu"
      data-variant={variant}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setFocusWithin(false);
        }
      }}
      onFocusCapture={() => setFocusWithin(true)}
    >
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.href
              ? (
                <a
                  aria-current={item.selected ? "page" : undefined}
                  aria-disabled={item.disabled || undefined}
                  href={item.disabled ? undefined : item.href}
                >
                  {item.label}
                </a>
              )
              : (
                <button
                  aria-pressed={variant === "selection"
                    ? item.selected
                    : undefined}
                  disabled={item.disabled}
                  onClick={() => onSelect?.(item.id)}
                  type="button"
                >
                  {item.label}
                </button>
              )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
