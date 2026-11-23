import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

export type StepGroupProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "title">>
  & {
    label: ReactNode;
    limit?: ReactNode;
    icon?: ReactNode;
    codeMark?: ReactNode;
    selected?: boolean;
    controls?: string;
    onSelect?: () => void;
    selectLabel?: string;
    empty?: ReactNode;
    variant?: "box" | "arm";
  };

export function StepGroup(
  {
    codeMark,
    controls,
    empty,
    icon,
    label,
    limit,
    onSelect,
    selectLabel,
    selected = false,
    variant = "box",
    ...props
  }: StepGroupProps,
) {
  const heading = (
    <>
      {icon === undefined
        ? null
        : <span aria-hidden="true" className="ui-step-group__icon">{icon}
        </span>}
      <span className="ui-step-group__label">{label}</span>
      {limit === undefined
        ? null
        : <span className="ui-step-group__limit">{limit}</span>}
    </>
  );
  return (
    <div
      {...props}
      className={[
        "ui-step-group",
        selected ? "ui-step-group--selected" : "",
      ].filter(Boolean).join(" ")}
      data-selected={selected ? "true" : undefined}
      data-state={selected ? "selected" : "default"}
      data-ui-component="stepGroup"
      data-variant={variant}
    >
      <div className="ui-step-group__top">
        {onSelect === undefined
          ? <span className="ui-step-group__header">{heading}</span>
          : (
            <button
              aria-controls={selected ? controls : undefined}
              aria-expanded={controls === undefined ? undefined : selected}
              aria-label={selectLabel}
              className="ui-step-group__header"
              onClick={onSelect}
              type="button"
            >
              {heading}
            </button>
          )}
        {codeMark === undefined
          ? null
          : <span className="ui-step-group__code">{codeMark}</span>}
      </div>
      {empty === undefined
        ? null
        : <span className="ui-step-group__empty">{empty}</span>}
    </div>
  );
}
