import type { HTMLAttributes, LiHTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../steps.css";

/**
 * The workflow as a list (#67, the canvas rebuild): the same steps and boxes
 * the diagram draws, one row each, boxes holding the rows inside them. It is
 * what a phone shows and what the diagram falls back to, so every edit the
 * diagram offers has a row here.
 */
export type OutlineListProps = SemanticNativeProps<
  HTMLAttributes<HTMLUListElement>
>;

/** A list of outline rows; a box's rows are a nested one. */
export function OutlineList({ children, ...props }: OutlineListProps) {
  return (
    <ul
      {...props}
      className="ui-outline"
      data-state="default"
      data-ui-component="outlineList"
      data-variant="default"
    >
      {children}
    </ul>
  );
}

export type OutlineRowProps =
  & SemanticNativeProps<Omit<LiHTMLAttributes<HTMLLIElement>, "title">>
  & {
    /** The step's or box's name. */
    title: ReactNode;
    /** The one muted line under the name. */
    summary?: ReactNode;
    /** The step type's icon, decorative and hidden from screen readers. */
    icon?: ReactNode;
    /** Whether the panel beside the list is showing this row. */
    selected?: boolean;
    /** The id of the panel the row opens. */
    controls?: string;
    /** The step cannot be read, or is a kind the editor does not know. */
    needsSetup?: boolean;
    /** The words for the needs-setup state, translated by the caller. */
    needsSetupLabel?: ReactNode;
    /** The mark that says the row is written in code, outside the row's button. */
    codeMark?: ReactNode;
    /** The row's accessible name, when more than its text is worth saying. */
    selectLabel?: string;
    /** Select the row. When absent the row is text. */
    onSelect?: () => void;
    /**
     * A caption row: the muted word that heads one arm of an If. It has no
     * icon and cannot be selected.
     */
    caption?: boolean;
    /** The rows inside a box: a nested `OutlineList`. */
    children?: ReactNode;
    /** The control that adds a step after this row, drawn between rows. */
    add?: ReactNode;
  };

/** One step, box or arm caption in the outline. */
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
