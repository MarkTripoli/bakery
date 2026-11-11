import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type DataTextProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    children: ReactNode;
    state?: "default" | "wrapped" | "truncated";
    truncate?: boolean;
    variant?: "identifier" | "timestamp" | "metric" | "code";
  };

export function DataText(
  {
    state = "default",
    truncate = false,
    variant = "identifier",
    ...props
  }: DataTextProps,
) {
  return (
    <span
      className={[
        "ui-data-text",
        `ui-data-text--${variant}`,
        (truncate || state === "truncated") &&
        "ui-data-text--truncate",
      ].filter(Boolean).join(" ")}
      data-rail={truncate || state === "truncated"
        ? "truncation-allowed"
        : undefined}
      {...props}
      data-state={state}
      data-ui-component="dataText"
      data-variant={variant}
    />
  );
}
