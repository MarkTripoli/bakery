import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

/**
 * A step of a workflow drawn as a card (#67, the owner's editor spec): a white
 * rounded surface with the step type's icon in a small tile, its name, and one
 * grey line under it — nothing else. No band, no badge, no port: the reference
 * has none of those and adding them would be chrome the owner never approved.
 *
 * It is a button because selecting the card is what opens the panel beside the
 * diagram, so a keyboard reaches it like any other control. When the editor
 * cannot read the step, the card keeps its surface, gains a red hairline and
 * says "Needs setup" in place of the grey line, so the state is never colour
 * alone.
 */
export type StepCardProps =
  & SemanticNativeProps<Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title">>
  & {
    /** The step type's own name; a person cannot name a step yet. */
    title: ReactNode;
    /** One line under the name: what the step does. */
    summary?: ReactNode;
    /** The step type's icon, decorative and hidden from screen readers. */
    icon?: ReactNode;
    /** Whether the panel beside the diagram is showing this step. */
    selected?: boolean;
    /** The id of the panel this card opens, so the expansion says what it opens. */
    controls?: string;
    /** The step cannot be read, or is a kind the editor does not know. */
    needsSetup?: boolean;
    /** The words for the needs-setup state, translated by the caller. */
    needsSetupLabel?: ReactNode;
    /** What the definition states, when the step could not be read. */
    writtenInCode?: ReactNode;
  };

/** A step drawn as a card, selectable, for the workflow diagram. */
export function StepCard(
  {
    controls,
    icon,
    needsSetup = false,
    needsSetupLabel,
    selected = false,
    summary,
    title,
    writtenInCode,
    ...props
  }: StepCardProps,
) {
  return (
    <button
      {...props}
      aria-controls={selected ? controls : undefined}
      aria-expanded={selected}
      className={[
        "ui-step-card",
        selected ? "ui-step-card--selected" : "",
        needsSetup ? "ui-step-card--needs-setup" : "",
      ].filter(Boolean).join(" ")}
      data-needs-setup={needsSetup ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-ui-component="stepCard"
      type="button"
    >
      <span aria-hidden="true" className="ui-step-card__icon">
        {icon}
      </span>
      <span className="ui-step-card__body">
        <span className="ui-step-card__title">{title}</span>
        <span
          className={needsSetup
            ? "ui-step-card__needs-setup"
            : "ui-step-card__summary"}
        >
          {needsSetup ? needsSetupLabel : summary}
        </span>
        {writtenInCode === undefined
          ? null
          : <span className="ui-step-card__written">{writtenInCode}</span>}
      </span>
    </button>
  );
}
