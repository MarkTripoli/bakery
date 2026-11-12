import type { ButtonHTMLAttributes } from "react";
import { IconButton } from "../atoms/IconButton.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import { Tooltip } from "./Tooltip.tsx";
import "../feedback.css";

export type HelpTipProps =
  & SemanticNativeProps<
    Omit<
      ButtonHTMLAttributes<HTMLButtonElement>,
      | "aria-describedby"
      | "aria-label"
      | "children"
      | "onBlur"
      | "onFocus"
      | "onKeyDown"
      | "onPointerEnter"
      | "onPointerLeave"
      | "title"
      | "type"
    >
  >
  & {
    /** The help text (a string, as `Tooltip` takes). It describes the button; it is never the only way to do the task. */
    children: string;
    /** The button's accessible name, such as "About enforcement". */
    label: string;
  };

/**
 * Explains the label it sits after: an information button that shows its help
 * text on hover, on keyboard focus and on a tap. Escape and leaving the button
 * close it. One tip per label or column, not one per value.
 */
export function HelpTip({ children, label, ...unsafeProps }: HelpTipProps) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  return (
    <span
      className="ui-help-tip"
      data-state="closed"
      data-ui-component="helpTip"
      data-variant="default"
    >
      <Tooltip content={children} variant="description">
        <IconButton {...props} label={label} variant="compact">
          <IconGlyph name="info" size="small" />
        </IconButton>
      </Tooltip>
    </span>
  );
}
