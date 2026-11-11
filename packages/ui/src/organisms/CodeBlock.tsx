import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type CodeBlockProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "children">>
  & {
    code: string;
    copied?: boolean;
    language?: string;
    state?: "default" | "copied" | "overflowing" | "long-content";
    variant?: "plain" | "syntax" | "command";
  };

export function CodeBlock(
  {
    code,
    copied = false,
    language,
    state = copied ? "copied" : "default",
    variant = "plain",
    ...props
  }: CodeBlockProps,
) {
  return (
    <pre
      className={["ui-code-block", `ui-code-block--${variant}`].filter(
        Boolean,
      ).join(" ")}
      {...props}
      tabIndex={props.tabIndex ?? (state === "overflowing" ? 0 : undefined)}
      data-state={state}
      data-variant={variant}
      data-ui-component="codeBlock"
    ><code data-language={language}>{code}</code>{copied ? <span aria-live="polite" className="ui-code-block__copied">Copied</span> : null}</pre>
  );
}
