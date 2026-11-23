import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

/**
 * The workflow as a list (#67, the canvas rebuild): the same steps and boxes
 * the diagram draws, one row each, boxes holding the rows inside them. It is
 * what a phone shows and what the diagram falls back to, so every edit the
 * diagram offers has a row here.
 */
export type OutlineListProps = SemanticNativeProps<
  HTMLAttributes<HTMLUListElement>
>;

/** A list of outline rows; a box's rows are a nested one. */
export function OutlineList({ children, ...props }: OutlineListProps) {
  return (
    <ul
      {...props}
      className="ui-outline"
      data-state="default"
      data-ui-component="outlineList"
      data-variant="default"
    >
      {children}
    </ul>
  );
}
