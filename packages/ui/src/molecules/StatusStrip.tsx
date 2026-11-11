import type { ReactNode } from "react";
import "../navigation.css";

export type StatusStripProps = {
  /** Accessible name of the region, e.g. "Worker readiness". */
  label: string;
  /** Status badges and short notes, in priority order. */
  children: ReactNode;
  state?: "default" | "attention";
  /** `footer` is the 48px desktop row; `compact` the phone row. */
  variant?: "footer" | "compact";
};

/**
 * Footer row of the work column that reports ambient readiness, e.g.
 * "1 worker ready · MacBook offline" (Paper 5J-0). Updates are announced
 * politely.
 */
export function StatusStrip(
  { children, label, state = "default", variant = "footer" }: StatusStripProps,
) {
  return (
    <section
      aria-label={label}
      aria-live="polite"
      className={`bakery-status-strip bakery-status-strip--${variant}`}
      data-state={state}
      data-ui-component="statusStrip"
      data-variant={variant}
    >
      {children}
    </section>
  );
}
