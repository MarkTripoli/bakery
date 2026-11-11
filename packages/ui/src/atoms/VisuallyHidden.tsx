import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../navigation.css";

export type VisuallyHiddenProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    children: ReactNode;
    /** Inline by default so it is valid inside links and buttons; pass `div` to hold block content. */
    as?: "span" | "div";
  };

/** Text only assistive technology reads, such as a control's extra context. */
export function VisuallyHidden(
  { children, as: Tag = "span", ...props }: VisuallyHiddenProps,
) {
  return (
    <Tag
      className="bakery-visually-hidden"
      {...props}
      data-state="default"
      data-ui-component="visuallyHidden"
      data-variant="default"
    >
      {children}
    </Tag>
  );
}
