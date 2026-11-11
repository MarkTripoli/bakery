import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type DividerProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    orientation?: "horizontal" | "vertical";
  };

export function Divider(
  { orientation = "horizontal", ...props }: DividerProps,
) {
  if (orientation === "vertical") {
    return (
      <div
        aria-orientation="vertical"
        className="ui-divider ui-divider--vertical"
        role="separator"
        {...props}
        data-state="default"
        data-ui-component="divider"
        data-variant="vertical"
      />
    );
  }
  return (
    <hr
      className="ui-divider ui-divider--horizontal"
      {...props}
      data-state="default"
      data-ui-component="divider"
      data-variant="horizontal"
    />
  );
}
