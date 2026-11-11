import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type DescriptionListProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
  };

/**
 * The container `DescriptionItem` rows stack in — Paper's `.list`
 * (auth.css:8). Rows carry their own bottom rule and touch, so this is a
 * gapless full-width column, not a `Stack`.
 */
export function DescriptionList({ children, ...props }: DescriptionListProps) {
  return (
    <div
      className="ui-description-list"
      {...props}
      data-state="default"
      data-ui-component="descriptionList"
      data-variant="default"
    >
      {children}
    </div>
  );
}
