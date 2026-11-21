import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { HelpTip } from "./HelpTip.tsx";
import "../data.css";

export type StatTileProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "title">>
  & {
    /** The figure or count, already formatted for the reader. */
    value: ReactNode;
    /** What the figure is, in two or three words. */
    label: string;
    /** One line under the label: what the figure means, or what it excludes. */
    detail?: ReactNode;
    /** Longer help behind an information button beside the label. */
    help?: { readonly text: string; readonly label: string };
    /**
     * Makes the figure a button that chooses it, for a page where a number opens
     * the records behind it. The help tip stays outside the button, because a
     * button may not contain another control; `actionLabel` names the button
     * ("Pull requests merged, 42") since its content is only the value.
     */
    action?: {
      readonly label: string;
      readonly onSelect: () => void;
      readonly selected?: boolean;
    };
  };

/**
 * One figure with its label, an optional one-line explanation and optional help.
 *
 * The point of the shape is that an unknown value stays legible as unknown: a
 * tile can print "Unknown" where a dashboard would print a zero, and `detail`
 * is where it says why. `aria-label` is not set on the region, because the
 * label is already inside it - a reader hears "Confirmed cost, $12.40, Backed
 * by the provider's own receipt" once rather than twice.
 */
export function StatTile(
  { value, label, detail, help, action, ...props }: StatTileProps,
) {
  return (
    <section
      className="ui-stat-tile"
      {...props}
      data-selected={action?.selected ? "true" : undefined}
      data-state="default"
      data-ui-component="statTile"
      data-variant="default"
    >
      <div className="ui-stat-tile__label">
        <span>{label}</span>
        {help ? <HelpTip label={help.label}>{help.text}</HelpTip> : null}
      </div>
      {action
        ? (
          <button
            aria-label={action.label}
            aria-pressed={action.selected ?? false}
            className="ui-stat-tile__action"
            onClick={action.onSelect}
            type="button"
          >
            <span className="ui-stat-tile__value">{value}</span>
          </button>
        )
        : <div className="ui-stat-tile__value">{value}</div>}
      {detail ? <div className="ui-stat-tile__detail">{detail}</div> : null}
    </section>
  );
}
