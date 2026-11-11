import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type InlineProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    children: ReactNode;
    gap?: "compact" | "standard" | "spacious";
    /**
     * `actions` = Paper `.two-actions` (auth.css:10, :13): a row of equal-width
     * buttons (12px gap) that wraps on phones; `split` is two equal columns
     * (16px gap); `thirds` is three equal columns (12px gap) that stack on phones; `flow` is the default content-sized row.
     */
    variant?: "flow" | "actions" | "split" | "thirds";
  };

export function Inline(
  { gap = "standard", variant = "flow", ...props }: InlineProps,
) {
  return (
    <div
      className={[
        "ui-inline",
        `ui-inline--${gap}`,
        variant === "actions" && "ui-inline--actions",
        variant === "split" && "ui-inline--split",
        variant === "thirds" && "ui-inline--thirds",
      ].filter(Boolean).join(" ")}
      {...props}
      data-state="default"
      data-ui-component="inline"
      data-variant={variant === "flow" ? gap : variant}
    />
  );
}
