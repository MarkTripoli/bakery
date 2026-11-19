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
  { value, label, detail, help, ...props }: StatTileProps,
) {
  return (
    <section
      className="ui-stat-tile"
      {...props}
      data-ui-component="statTile"
    >
      <div className="ui-stat-tile__label">
        <span>{label}</span>
        {help ? <HelpTip label={help.label}>{help.text}</HelpTip> : null}
      </div>
      <div className="ui-stat-tile__value">{value}</div>
      {detail ? <div className="ui-stat-tile__detail">{detail}</div> : null}
    </section>
  );
}
