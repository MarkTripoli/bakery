import type { HTMLAttributes, ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type AlertBannerProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    action?: ReactNode;
    children: ReactNode;
    onDismiss?: () => void;
    state?: "default" | "recovering" | "dismissed";
    tone?: "information" | "success" | "warning" | "error";
  };

const TONE_GLYPH = {
  information: "info",
  success: "check",
  warning: "alert",
  error: "alert",
} as const;

/** Announces a persistent page or major-region condition. */
export function AlertBanner(
  {
    action,
    children,
    onDismiss,
    state = "default",
    tone = "information",
    ...props
  }: AlertBannerProps,
) {
  if (state === "dismissed") {
    return (
      <div
        aria-hidden="true"
        className={["ui-alert-banner", `ui-alert-banner--${tone}`].join(" ")}
        {...props}
        data-state={state}
        data-ui-component="alertBanner"
        data-variant={tone}
        hidden
      />
    );
  }
  return (
    <div
      aria-busy={state === "recovering" || undefined}
      className={["ui-alert-banner", `ui-alert-banner--${tone}`].filter(
        Boolean,
      ).join(" ")}
      role={tone === "error" ? "alert" : "status"}
      {...props}
      data-state={state}
      data-ui-component="alertBanner"
      data-variant={tone}
    >
      <div className="ui-alert-banner__icon">
        <IconGlyph name={TONE_GLYPH[tone]} size="large" />
      </div>
      <div className="ui-alert-banner__content">{children}</div>
      {action ? <div className="ui-alert-banner__action">{action}</div> : null}
      {onDismiss
        ? (
          <button
            aria-label="Dismiss alert"
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
