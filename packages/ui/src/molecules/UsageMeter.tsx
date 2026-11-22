import type { HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type UsageMeterMark = {
  /** Where the mark sits, as a share of the limit: 0.75 is three quarters. */
  readonly at: number;
};

export type UsageMeterProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "title">>
  & {
    /** Names the meter for assistive technology, such as "Storage used". */
    label: string;
    /** How much is used, in the same unit as `limit`. */
    value: number;
    /** The most there can be. Above zero. */
    limit: number;
    /** The reading in words, such as "78.2 GB of 100 GB". It is the meter's value for assistive technology. */
    valueText: string;
    /** How the use stands: the fill is plain, then warning, then destructive. */
    state: "ok" | "warning" | "paused";
    /** Ticks on the track where the state changes; the page explains them in words. */
    marks?: readonly UsageMeterMark[];
  };

/**
 * A bar that shows how much of a limit is used, with ticks where the state
 * changes.
 *
 * The bar is a picture: the reading is its accessible value, and the caller
 * puts the same words, and what the ticks mean, in the page. Colour follows the
 * state, and the state is also written by the caller, so colour is never the
 * only cue.
 */
export function UsageMeter(
  { label, value, limit, valueText, state, marks = [], ...props }:
    UsageMeterProps,
) {
  const share = limit > 0 ? Math.min(Math.max(value / limit, 0), 1) : 0;
  return (
    <div
      className="ui-usage-meter"
      {...props}
      data-state={state}
      data-ui-component="usageMeter"
      data-variant="default"
    >
      <div
        aria-label={label}
        aria-valuemax={limit}
        aria-valuemin={0}
        aria-valuenow={Math.min(Math.max(value, 0), limit)}
        aria-valuetext={valueText}
        className="ui-usage-meter__track"
        role="meter"
      >
        <div className="ui-usage-meter__bar">
          <span
            className="ui-usage-meter__fill"
            style={{ inlineSize: `${share * 100}%` }}
          />
        </div>
        {marks.map((mark) => (
          <span
            aria-hidden="true"
            className="ui-usage-meter__mark"
            key={mark.at}
            style={{ insetInlineStart: `${mark.at * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
