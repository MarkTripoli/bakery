import type { LiHTMLAttributes, ReactNode } from "react";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

export type ActivityLineTone = "neutral" | "danger" | "success";

export type ActivityLineProps =
  & SemanticNativeProps<LiHTMLAttributes<HTMLLIElement>>
  & {
    /** Sentence the line says, already translated. */
    children: ReactNode;
    /**
     * What the line is about, drawn before the sentence. Omit it for a line
     * that is a sentence only, such as a usage total.
     */
    icon?: IconGlyphName;
    /** When given, the line becomes a button that expands `detail`. */
    detail?: {
      readonly expanded: boolean;
      readonly onToggle: () => void;
      readonly content: ReactNode;
    };
    /** Right-aligned time; pass the localized text and its exact title. */
    time?: string;
    timeTitle?: string;
    tone?: ActivityLineTone;
  };

/**
 * One event in a session: an icon, a sentence and a time.
 *
 * Nothing in the catalog draws a single-line event, and both the session thread
 * and the run timeline need one, so it is shared rather than owned by either.
 * Status is never colour alone: the icon shape differs per tone and the sentence
 * says what happened.
 */
export function ActivityLine(
  {
    children,
    detail,
    icon,
    time,
    timeTitle,
    tone = "neutral",
    ...props
  }: ActivityLineProps,
) {
  const row = (
    <>
      {icon
        ? (
          <span className="ui-activity-line__icon">
            <IconGlyph name={icon} />
          </span>
        )
        : null}
      <span className="ui-activity-line__text">{children}</span>
      {detail
        ? (
          <span
            className="ui-activity-line__chevron"
            data-expanded={detail.expanded ? "true" : "false"}
          >
            <IconGlyph name="chevron-down" />
          </span>
        )
        : null}
      {time
        ? (
          <time className="ui-activity-line__time" dateTime={timeTitle}>
            {time}
          </time>
        )
        : null}
    </>
  );
  return (
    <li
      className="ui-activity-line"
      data-tone={tone}
      data-variant={tone}
      data-state={detail
        ? (detail.expanded ? "expanded" : "collapsed")
        : undefined}
      data-ui-component="activityLine"
      {...props}
    >
      {detail
        ? (
          <button
            type="button"
            className="ui-activity-line__row"
            aria-expanded={detail.expanded}
            onClick={detail.onToggle}
          >
            {row}
          </button>
        )
        : <span className="ui-activity-line__row">{row}</span>}
      {detail?.expanded ? detail.content : null}
    </li>
  );
}
