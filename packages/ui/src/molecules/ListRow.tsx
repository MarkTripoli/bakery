import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ListRowProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** Accessible name of the row control when `onSelect` is set. */
    controlLabel?: string;
    /** Muted line under the title; `warning` tints it. */
    detail?: ReactNode;
    detailTone?: "default" | "warning" | "code";
    onSelect?: () => void;
    /** `tall` rows hold a status pill and are 60px; `regular` rows are 56px. */
    size?: "regular" | "tall";
    selected?: boolean;
    title: ReactNode;
    /** Trailing status or glyph. */
    trailing?: ReactNode;
  };

/** A phone list row: title over a detail line, with a trailing status. */
export function ListRow(
  {
    controlLabel,
    detail,
    detailTone = "default",
    onSelect,
    selected = false,
    size = "regular",
    title,
    trailing,
    ...props
  }: ListRowProps,
) {
  const content = (
    <>
      <span className="ui-list-row__lead">
        <span className="ui-list-row__title">{title}</span>
        {detail
          ? (
            <span className="ui-list-row__detail" data-tone={detailTone}>
              {detail}
            </span>
          )
          : null}
      </span>
      {trailing}
    </>
  );
  return (
    <div
      className="ui-list-row"
      {...props}
      data-selected={selected ? "true" : undefined}
      data-size={size}
      data-state="default"
      data-ui-component="listRow"
      data-variant={onSelect ? "selectable" : "static"}
    >
      {onSelect
        ? (
          <button
            aria-label={controlLabel}
            aria-pressed={selected}
            className="ui-list-row__control"
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
