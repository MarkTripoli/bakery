import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type DataTextProps =
  & SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>
  & {
    children: ReactNode;
    state?: "default" | "wrapped" | "truncated";
    truncate?: boolean;
    /**
     * Opt-in: the value takes the room it needs instead of a line to itself,
     * so it can share a line with a control beside it (a fingerprint and its
     * Copy button). Without it a value fills its line.
     */
    fit?: boolean;
    variant?: "identifier" | "timestamp" | "metric" | "code";
  };

export function DataText(
  {
    fit = false,
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
        fit && "ui-data-text--fit",
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
