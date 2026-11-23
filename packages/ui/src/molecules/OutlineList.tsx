import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

export type OutlineListProps = SemanticNativeProps<
  HTMLAttributes<HTMLUListElement>
>;

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
