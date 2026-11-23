import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

/**
 * A box in the workflow diagram (#67, the canvas on React Flow): the frame
 * around steps that belong together: For each, Repeat, Fix until it passes,
 * At the same time, and the If that holds a Yes and an Otherwise arm. It draws
 * the frame and its header only. Where the steps inside sit is the layout's
 * decision, so the canvas places them over the frame and the outline nests
 * them under a row.
 *
 * With `onSelect` the header is one button, so a keyboard reaches the box like
 * a step card and its panel opens. Without it the header is plain text, never a
 * disabled button, so a read-only page reads at full strength.
 */
export type StepGroupProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "title">>
  & {
    /** What kind of box this is, in the person's words: "For each item", "If". */
    label: ReactNode;
    /** The most items or tries the box states, in muted words after the label. */
    limit?: ReactNode;
    /** The box's icon, decorative and hidden from screen readers. */
    icon?: ReactNode;
    /**
     * The mark that says the box is written in code, at the right of the
     * header. It sits outside the header button so it adds no tab stop; the
     * caller puts the same words in `selectLabel` for a screen reader.
     */
    codeMark?: ReactNode;
    /** Whether the panel beside the diagram is showing this box. */
    selected?: boolean;
    /** The id of the panel the header opens, so the expansion says what it opens. */
    controls?: string;
    /** Select the box. When absent the header is text. */
    onSelect?: () => void;
    /** The header button's accessible name, with the count of steps inside. */
    selectLabel?: string;
    /** The one muted line an empty box shows. */
    empty?: ReactNode;
    /**
     * `box` is the framed box. `arm` is one column of an If: its caption and
     * nothing else, because the If's own frame already surrounds it.
     */
    variant?: "box" | "arm";
  };

/** The frame and header of a group of steps, for the diagram. */
export function StepGroup(
  {
    codeMark,
    controls,
    empty,
    icon,
    label,
    limit,
    onSelect,
    selectLabel,
    selected = false,
    variant = "box",
    ...props
  }: StepGroupProps,
) {
  const heading = (
    <>
      {icon === undefined
        ? null
        : <span aria-hidden="true" className="ui-step-group__icon">{icon}
        </span>}
      <span className="ui-step-group__label">{label}</span>
      {limit === undefined
        ? null
        : <span className="ui-step-group__limit">{limit}</span>}
    </>
  );
  return (
    <div
      {...props}
      className={[
        "ui-step-group",
        selected ? "ui-step-group--selected" : "",
      ].filter(Boolean).join(" ")}
      data-selected={selected ? "true" : undefined}
      data-state={selected ? "selected" : "default"}
      data-ui-component="stepGroup"
      data-variant={variant}
    >
      <div className="ui-step-group__top">
        {onSelect === undefined
          ? <span className="ui-step-group__header">{heading}</span>
          : (
            <button
              aria-controls={selected ? controls : undefined}
              aria-expanded={controls === undefined ? undefined : selected}
              aria-label={selectLabel}
              className="ui-step-group__header"
              onClick={onSelect}
              type="button"
            >
              {heading}
            </button>
          )}
        {codeMark === undefined
          ? null
          : <span className="ui-step-group__code">{codeMark}</span>}
      </div>
      {empty === undefined
        ? null
        : <span className="ui-step-group__empty">{empty}</span>}
    </div>
  );
}
