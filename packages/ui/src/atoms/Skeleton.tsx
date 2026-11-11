import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type SkeletonProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    shape?: "text" | "control" | "row" | "surface";
  };

/** Reserves layout while content is loading. */
export function Skeleton({ shape = "text", ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={["ui-skeleton", `ui-skeleton--${shape}`].filter(Boolean).join(
        " ",
      )}
      {...props}
      data-state="loading"
      data-ui-component="skeleton"
      data-variant={shape}
    />
  );
}
