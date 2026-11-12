import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "./atoms.css";

export type TextProps =
  & SemanticNativeProps<HTMLAttributes<HTMLParagraphElement>>
  & {
    children: ReactNode;
    state?: "default" | "truncated" | "long-content";
    truncate?: boolean;
    /** Clamps the text to this many lines, then an ellipsis; give it a `title` with the whole text. */
    lines?: 2;
    variant?:
      | "body"
      | "caption"
      | "hint"
      | "muted"
      | "strong"
      | "hintInk"
      | "captionInk"
      | "positive"
      | "field-preview"
      | "responsive-hint";
  };

export function Text(
  { lines, state = "default", truncate = false, variant = "body", ...props }:
    TextProps,
) {
  return (
    <p
      className={[
        "ui-text",
        `ui-text--${variant}`,
        (truncate || state === "truncated") &&
        "ui-text--truncate",
      ].filter(Boolean).join(" ")}
      data-lines={lines}
      data-rail={truncate || state === "truncated" || lines
        ? "truncation-allowed"
        : undefined}
      {...props}
      data-state={state}
      data-ui-component="text"
      data-variant={variant}
    />
  );
}
