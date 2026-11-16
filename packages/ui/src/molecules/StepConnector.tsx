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
  };

/** The line between two cards, with the round "+" that adds a step there. */
export function StepConnector(
  { children, label, ...props }: StepConnectorProps,
) {
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
