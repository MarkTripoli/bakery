import type { LiHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

export type OutlineRowProps =
  & SemanticNativeProps<Omit<LiHTMLAttributes<HTMLLIElement>, "title">>
  & {
    title: ReactNode;
    summary?: ReactNode;
    icon?: ReactNode;
    selected?: boolean;
    controls?: string;
    needsSetup?: boolean;
    needsSetupLabel?: ReactNode;
    codeMark?: ReactNode;
    selectLabel?: string;
    onSelect?: () => void;
    caption?: boolean;
    children?: ReactNode;
    add?: ReactNode;
  };

export function OutlineRow(
  {
    add,
    caption = false,
    children,
    codeMark,
    controls,
    icon,
    needsSetup = false,
    needsSetupLabel,
    onSelect,
    selectLabel,
    selected = false,
    summary,
    title,
    ...props
  }: OutlineRowProps,
) {
  const body = (
    <>
      {icon === undefined
        ? null
        : <span aria-hidden="true" className="ui-outline__icon">{icon}</span>}
      <span className="ui-outline__body">
        <span className="ui-outline__title">{title}</span>
        {needsSetup
          ? <span className="ui-outline__needs-setup">{needsSetupLabel}</span>
          : summary === undefined
          ? null
          : <span className="ui-outline__summary">{summary}</span>}
      </span>
    </>
  );
  return (
    <li
      {...props}
      className="ui-outline__item"
      data-caption={caption ? "true" : undefined}
      data-needs-setup={needsSetup ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-state={needsSetup
        ? "needs-setup"
        : selected
        ? "selected"
        : "default"}
      data-ui-component="outlineRow"
      data-variant={caption ? "caption" : "row"}
    >
      {caption
        ? <span className="ui-outline__caption">{title}</span>
        : (
          <div className="ui-outline__row">
            {onSelect === undefined
              ? <span className="ui-outline__main">{body}</span>
              : (
                <button
                  aria-controls={selected ? controls : undefined}
                  aria-expanded={controls === undefined ? undefined : selected}
                  aria-label={selectLabel}
                  className="ui-outline__main"
                  onClick={onSelect}
                  type="button"
                >
                  {body}
                </button>
              )}
            {codeMark === undefined
              ? null
              : <span className="ui-outline__code">{codeMark}</span>}
          </div>
        )}
      {children}
      {add === undefined ? null : <div className="ui-outline__add">{add}</div>}
    </li>
  );
}
