import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import "../collaboration.css";

export type PlanSummaryCardProps =
  & SemanticNativeProps<
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title">
  >
  & {
    /** One quiet line under the title, such as the decision status. */
    meta: ReactNode;
    /** Tone of the meta line. */
    tone?: "warning" | "neutral";
    title: ReactNode;
  };

/**
 * A compact card that stands for a plan inside a narrow transcript and opens
 * it: glyph, title, status line and a chevron.
 */
export function PlanSummaryCard(
  { meta, title, tone = "neutral", type = "button", ...props }:
    PlanSummaryCardProps,
) {
  return (
    <button
      className={`ui-plan-summary-card ui-plan-summary-card--${tone}`}
      type={type}
      {...props}
      data-state="default"
      data-ui-component="planSummaryCard"
      data-variant={tone}
    >
      <IconGlyph name="plan" />
      <span className="ui-plan-summary-card__text">
        <span className="ui-plan-summary-card__title">{title}</span>
        <span className="ui-plan-summary-card__meta">{meta}</span>
      </span>
      <IconGlyph name="chevron-right" size="small" />
    </button>
  );
}
