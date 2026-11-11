import type { ReactNode } from "react";
import "../data.css";

export type Breadcrumb = { href?: string; label: ReactNode };
export type BreadcrumbsProps = {
  "aria-label"?: string;
  items: Breadcrumb[];
  state?: "default" | "focus";
  variant?: "full" | "collapsed";
};

export function Breadcrumbs(
  {
    "aria-label": ariaLabel = "Breadcrumb",
    items,
    state = "default",
    variant = "full",
  }: BreadcrumbsProps,
) {
  return (
    <nav
      aria-label={ariaLabel}
      className={`ui-breadcrumbs ui-breadcrumbs--${variant}`}
      data-ui-component="breadcrumbs"
      data-state={state}
      data-variant={variant}
    >
      <ol>
        {items.map((item, index) => (
          <li key={index}>
            {index === items.length - 1 || !item.href
              ? (
                <span
                  aria-current={index === items.length - 1 ? "page" : undefined}
                >
                  {item.label}
                </span>
              )
              : <a href={item.href}>{item.label}</a>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
