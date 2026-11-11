import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type RevisionRowProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** Accessible name of the row control when `onSelect` is set. */
    controlLabel?: string;
    /** Short identity such as a digest. */
    detail: ReactNode;
    /** Marks the row as the current choice. */
    selected?: boolean;
    /** Makes the row a button. */
    onSelect?: () => void;
    title: ReactNode;
    /** Trailing status or date. */
    trailing: ReactNode;
  };

/** One immutable revision: its number, digest and status or date. */
export function RevisionRow(
  {
    controlLabel,
    detail,
    onSelect,
    selected = false,
    title,
    trailing,
    ...props
  }: RevisionRowProps,
) {
  const content = (
    <>
      <span className="ui-revision-row__title">{title}</span>
      <span className="ui-revision-row__detail">{detail}</span>
      <span className="ui-revision-row__trailing">{trailing}</span>
    </>
  );
  return (
    <div
      className="ui-revision-row"
      {...props}
      data-selected={selected ? "true" : undefined}
      data-state="default"
      data-ui-component="revisionRow"
      data-variant={onSelect ? "selectable" : "static"}
    >
      {onSelect
        ? (
          <button
            aria-label={controlLabel}
            aria-pressed={selected}
            className="ui-revision-row__control"
            onClick={onSelect}
            type="button"
          >
            {content}
          </button>
        )
        : content}
    </div>
  );
}
