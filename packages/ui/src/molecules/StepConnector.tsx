import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

/**
 * The link between two cards in the workflow diagram (#67): a one-pixel line
 * with a small round "+" sitting on it. The "+" is the control that opens the
 * step picker, and it is round and small because the reference draws it that
 * way — a full-width bordered box between cards is a different object.
 *
 * The button keeps a 44px hit area while the visible circle stays small, so the
 * target is comfortable without the line looking heavy.
 */
export type StepConnectorProps =
  & SemanticNativeProps<
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title">
  >
  & {
    /** The accessible name: what pressing it does. */
    label: string;
    /** The glyph inside the circle; a plain "+" when absent. */
    children?: ReactNode;
    /**
     * Draw the line with no "+" on it (#67): a read-only workflow still shows
     * the path between its cards, it just has nothing to press. The control is
     * not rendered at all, so no empty button is reachable by keyboard.
     */
    readOnly?: boolean;
    /** The word that ends the path, drawn under the line of a read-only link. */
    endLabel?: ReactNode;
  };

/** The line between two cards, with the round "+" that adds a step there. */
export function StepConnector(
  { children, endLabel, label, readOnly, ...props }: StepConnectorProps,
) {
  if (readOnly) {
    return (
      <span className="ui-step-connector" data-read-only="true">
        <span aria-hidden="true" className="ui-step-connector__line" />
        {endLabel === undefined
          ? null
          : <span className="ui-step-connector__end">{endLabel}</span>}
      </span>
    );
  }
  return (
    <span className="ui-step-connector">
      <span aria-hidden="true" className="ui-step-connector__line" />
      <button
        {...props}
        aria-label={label}
        className="ui-step-connector__button"
        data-ui-component="stepConnector"
        type="button"
      >
        <span aria-hidden="true">{children ?? "+"}</span>
      </button>
    </span>
  );
}
