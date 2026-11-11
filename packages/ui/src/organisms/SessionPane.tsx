import type { ReactNode } from "react";
import "../collaboration.css";

export type SessionPaneProps = {
  /** Accessible name of the complementary region. */
  label: string;
  /** Title row: glyph, pane title and one trailing control (HU-0 64px row). */
  header: ReactNode;
  children: ReactNode;
  /** Pane actions pinned to the bottom, ruled above. */
  footer?: ReactNode;
  /** Summary heading of the pane content and one meta line (HU-0 20/600). */
  title?: ReactNode;
  meta?: ReactNode;
  state?: "default" | "loading" | "empty";
  /**
   * `sections` lays `PaneSection` children edge to edge, each carrying its
   * own inset (p-18-0 conversation inspector).
   */
  layout?: "stacked" | "sections";
};

/**
 * Flush side pane of a task session (Paper HU-0): a ruled title row, body
 * sections that carry their own inset, and a ruled footer of actions.
 */
export function SessionPane(
  {
    children,
    footer,
    header,
    label,
    layout = "stacked",
    meta,
    state = "default",
    title,
  }: SessionPaneProps,
) {
  return (
    <aside
      aria-busy={state === "loading" || undefined}
      aria-label={label}
      className="ui-session-pane"
      data-layout={layout}
      data-state={state}
      data-ui-component="sessionPane"
      data-variant="flush"
    >
      <div className="ui-session-pane__header">{header}</div>
      <div className="ui-session-pane__body">
        {title || meta
          ? (
            <div className="ui-session-pane__summary">
              {title ? <h2>{title}</h2> : null}
              {meta ? <p>{meta}</p> : null}
            </div>
          )
          : null}
        {children}
      </div>
      {footer ? <div className="ui-session-pane__footer">{footer}</div> : null}
    </aside>
  );
}
