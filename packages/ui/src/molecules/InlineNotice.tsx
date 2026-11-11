import type { HTMLAttributes, ReactNode } from "react";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type InlineNoticeProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    action?: ReactNode;
    children: ReactNode;
    /** Glyph that replaces the tone glyph, for example a clock for a wait. */
    icon?: IconGlyphName;
    /** `bar` is the single-line strip above a composer or pane (p-18-0). */
    layout?: "block" | "bar";
    /** `page` insets a bar by the 32px page inset (p-18-0 coordination). */
    inset?: "none" | "page";
    onDismiss?: () => void;
    state?: "default" | "dismissed";
    tone?: "neutral" | "information" | "success" | "warning" | "error";
  };

const TONE_GLYPH = {
  neutral: "document",
  information: "document",
  success: "check",
  warning: "alert",
  error: "alert",
} as const;

/** Explains a condition affecting nearby content. */
export function InlineNotice(
  {
    action,
    children,
    icon,
    inset = "none",
    layout = "block",
    onDismiss,
    state = "default",
    tone = "neutral",
    ...props
  }: InlineNoticeProps,
) {
  if (state === "dismissed") {
    return (
      <div
        aria-hidden="true"
        className={["ui-inline-notice", `ui-inline-notice--${tone}`].join(
          " ",
        )}
        {...props}
        data-state={state}
        data-ui-component="inlineNotice"
        data-variant={tone}
        hidden
      />
    );
  }
  return (
    <div
      className={[
        "ui-inline-notice",
        `ui-inline-notice--${tone}`,
        layout === "bar" ? "ui-inline-notice--bar" : "",
      ].filter(Boolean).join(" ")}
      role={tone === "error" ? "alert" : "status"}
      {...props}
      data-inset={inset === "page" ? "page" : undefined}
      data-state={state}
      data-ui-component="inlineNotice"
      data-variant={tone}
    >
      <div className="ui-inline-notice__icon">
        <IconGlyph
          name={icon ?? TONE_GLYPH[tone]}
          size={layout === "bar" ? "small" : "large"}
        />
      </div>
      <div className="ui-inline-notice__content">{children}</div>
      {action ? <div className="ui-inline-notice__action">{action}</div> : null}
      {onDismiss
        ? (
          <button
            aria-label="Dismiss notice"
            className="ui-feedback-dismiss"
            onClick={onDismiss}
            type="button"
          >
            ×
          </button>
        )
        : null}
    </div>
  );
}
