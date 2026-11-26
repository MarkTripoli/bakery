import { type HTMLAttributes, type ReactNode, useId } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ListRowProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** Accessible name of the row control when `onSelect` is set. */
    controlLabel?: string;
    /** A short caption on the title's line, such as "Edited". */
    badge?: ReactNode;
    /** Muted line under the title; `warning` tints it. */
    detail?: ReactNode;
    detailTone?: "default" | "warning" | "code";
    /**
     * Clamps the detail to this many lines, then an ellipsis. There is no
     * `title`: a tooltip cannot be opened by keyboard or touch. Make the whole
     * text reachable another way, for example by opening the row. A selectable
     * row describes its control with the detail, so a screen reader reads the
     * whole text after the control's name.
     */
    detailLines?: 2;
    onSelect?: () => void;
    /** `tall` rows hold a status pill and are 60px; `regular` rows are 56px. */
    size?: "regular" | "tall";
    selected?: boolean;
    title: ReactNode;
    titleEnd?: string | undefined;
    /** Trailing status or glyph. */
    trailing?: ReactNode;
  };

/** A phone list row: title over a detail line, with a trailing status. */
export function ListRow(
  {
    controlLabel,
    badge,
    detail,
    detailLines,
    detailTone = "default",
    onSelect,
    selected = false,
    size = "regular",
    title,
    titleEnd,
    trailing,
    ...props
  }: ListRowProps,
) {
  const detailId = useId();
  const name = titleEnd === undefined
    ? <span className="ui-list-row__title">{title}</span>
    : (
      <span
        className="ui-list-row__title"
        data-middle="true"
        title={`${String(title)}${titleEnd}`}
      >
        <span
          className="ui-list-row__title-start"
          data-rail="truncation-allowed"
        >
          {title}
        </span>
        <span className="ui-list-row__title-end">{titleEnd}</span>
      </span>
    );
  const content = (
    <>
      <span className="ui-list-row__lead">
        {badge
          ? (
            <span className="ui-list-row__headline">
              {name}
              {badge}
            </span>
          )
          : name}
        {detail
          ? (
            <span
              className="ui-list-row__detail"
              data-lines={detailLines}
              data-rail={detailLines ? "truncation-allowed" : undefined}
              data-tone={detailTone}
              id={detailId}
            >
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
            aria-describedby={detail ? detailId : undefined}
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
