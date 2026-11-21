import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type SegmentedBarPart = {
  /** Stable identity of the part, for its key. */
  readonly id: string;
  /** What the part is, in two or three words. */
  readonly label: string;
  /** How much the part holds; its width is its share of the whole. Above zero. */
  readonly value: number;
  /**
   * One of four greys, in order from darkest, or `unknown`: a hatched part for
   * what Bakery has no record of. Hatching, not colour, says "not recorded".
   */
  readonly tone: "first" | "second" | "third" | "fourth" | "unknown";
  /** What the part holds, in words, shown beside its label in the key. */
  readonly detail: ReactNode;
};

export type SegmentedBarProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "title">>
  & {
    /** Names the whole bar for assistive technology, with its parts in words. */
    label: string;
    /** The parts left to right; they add up to the whole. */
    parts: readonly SegmentedBarPart[];
  };

/**
 * One bar split into the parts of a whole, with a key that says each part in
 * words.
 *
 * The bar itself is a picture: the key under it is the content, so no part is
 * told by colour alone and a part too narrow to see is still listed. A part of
 * zero is not drawn and not listed: a category with no time does not appear.
 */
export function SegmentedBar(
  { label, parts, ...props }: SegmentedBarProps,
) {
  const shown = parts.filter((part) => part.value > 0);
  return (
    <figure
      className="ui-segmented-bar"
      {...props}
      data-state="default"
      data-ui-component="segmentedBar"
      data-variant="default"
    >
      <div aria-label={label} className="ui-segmented-bar__bar" role="img">
        {shown.map((part) => (
          <span
            className="ui-segmented-bar__part"
            data-tone={part.tone}
            key={part.id}
            style={{ flexGrow: part.value }}
          />
        ))}
      </div>
      <ul className="ui-segmented-bar__key">
        {shown.map((part) => (
          <li className="ui-segmented-bar__item" key={part.id}>
            <span
              aria-hidden="true"
              className="ui-segmented-bar__swatch"
              data-tone={part.tone}
            />
            <span className="ui-segmented-bar__name">{part.label}</span>
            <span className="ui-segmented-bar__detail">{part.detail}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
