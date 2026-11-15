import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type DescriptionListProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
    /**
     * `page` lines the list up with a page's table on a page whose main area
     * has no inset of its own (the coordination plan).
     */
    inset?: "page";
    /**
     * Opt-in: `quiet` sets each row's title in the body weight, for a list of
     * facts whose values are small, so the label is the quieter of the two. The
     * default (the heavy subsection weight) is for a list of things to choose.
     */
    labels?: "quiet";
  };

/**
 * The container `DescriptionItem` rows stack in — Paper's `.list`
 * (auth.css:8). Rows carry their own bottom rule and touch, so this is a
 * gapless full-width column, not a `Stack`.
 */
export function DescriptionList(
  { children, inset, labels, ...props }: DescriptionListProps,
) {
  return (
    <div
      className="ui-description-list"
      data-inset={inset}
      data-labels={labels}
      {...props}
      data-state="default"
      data-ui-component="descriptionList"
      data-variant="default"
    >
      {children}
    </div>
  );
}
