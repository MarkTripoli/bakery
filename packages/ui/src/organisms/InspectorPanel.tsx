import type { ReactNode } from "react";
import "../navigation.css";

export type InspectorPanelProps = {
  /** Accessible name of the complementary region. */
  label: string;
  /** Header row content: the selected object's title and its controls. */
  header?: ReactNode;
  children: ReactNode;
  /** Actions pinned to the bottom of the panel. */
  footer?: ReactNode;
  state?: "default" | "empty";
  /**
   * `column` fills the rail profile's full-height right column; `stacked`
   * sits below the work surface on pane and sheet. `sections` is the p-18-0
   * column: a ruled 64px header over unpadded pane sections.
   */
  variant?: "column" | "stacked" | "sections";
};

/**
 * Right-hand detail column for the selected object (Paper 5J-0 inspector,
 * 320px). On narrower profiles the shell places it below the work surface.
 */
export function InspectorPanel(
  {
    children,
    footer,
    header,
    label,
    state = "default",
    variant = "column",
  }: InspectorPanelProps,
) {
  return (
    <aside
      aria-label={label}
      className={`bakery-inspector-panel bakery-inspector-panel--${variant}`}
      data-state={state}
      data-ui-component="inspectorPanel"
      data-variant={variant}
    >
      {header
        ? <div className="bakery-inspector-panel__header">{header}</div>
        : null}
      <div className="bakery-inspector-panel__body">{children}</div>
      {footer
        ? <div className="bakery-inspector-panel__footer">{footer}</div>
        : null}
    </aside>
  );
}
