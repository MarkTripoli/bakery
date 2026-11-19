import type { ReactNode } from "react";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import "../collaboration.css";

export type SessionNowLineProps = {
  /** active: working; idle: waiting; danger: failed; warning: connection lost. */
  tone: "active" | "idle" | "danger" | "warning";
  children: ReactNode;
  /** A glyph instead of the status dot, for a failure or a lost connection. */
  icon?: IconGlyphName;
  /** Fine print at the edge, hidden from assistive technology so it never re-announces. */
  edge?: string;
  /** Makes the whole sentence a button, for a line about a step the reader is not looking at. */
  onSelect?: () => void;
  /** A control after the sentence, for example "Try now". */
  action?: ReactNode;
};

/**
 * What is happening in a session right now, as one quiet line above the
 * composer.
 *
 * It is the thread's only live region: new step lines do not announce
 * themselves, so a screen reader hears one changing sentence instead of a
 * stream of rows. The shimmer on a running line stops under reduced motion.
 */
export function SessionNowLine(
  { action, children, edge, icon, onSelect, tone }: SessionNowLineProps,
) {
  const text = <span className="ui-session-now__text">{children}</span>;
  return (
    <p
      className="ui-session-now"
      data-tone={tone}
      data-variant={tone}
      data-state="default"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-ui-component="sessionNowLine"
    >
      <span className="ui-session-now__mark" aria-hidden="true">
        {icon
          ? <IconGlyph name={icon} />
          : <span className="ui-session-now__dot" />}
      </span>
      {onSelect
        ? (
          <button
            type="button"
            className="ui-session-now__select"
            onClick={onSelect}
          >
            {text}
          </button>
        )
        : text}
      {edge
        ? (
          <span className="ui-session-now__elapsed" aria-hidden="true">
            {edge}
          </span>
        )
        : null}
      {action}
    </p>
  );
}
