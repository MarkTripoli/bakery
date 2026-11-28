import {
  type HTMLAttributes,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../atoms/Button.tsx";
import { Text, type TextProps } from "../atoms/Text.tsx";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../data.css";

export type ExpandableTextProps =
  & Omit<SemanticNativeProps<HTMLAttributes<HTMLDivElement>>, "children">
  & {
    children: string;
    /** The visible words on the closed control, for example "Show all". */
    showLabel: string;
    /** The visible words on the open control, for example "Show less". */
    hideLabel: string;
    /**
     * Accessible names that start with the visible words and say which text
     * they open, for example "Show all of Required sections". They tell several
     * controls on one page apart; each defaults to its visible label.
     */
    showControlLabel?: string;
    hideControlLabel?: string;
    /** The `Text` variant of the summary. */
    variant?: TextProps["variant"];
    /** How many lines the text keeps while closed. Two by default. */
    lines?: 2 | 3 | 6;
    /** Starts showing the whole text. Closed by default. */
    defaultExpanded?: boolean;
  };

/** The clamp the text keeps while closed, in lines. */
const CLAMP_LINES = 2;

/**
 * A summary clamped to two lines, with a text button that shows the whole of
 * it. The button exists only while the text is actually cut, so a summary that
 * fits looks exactly as it did and keeps no empty space. The whole text is
 * reachable by keyboard and touch: it is never only a `title`.
 */
export function ExpandableText(
  {
    children,
    defaultExpanded = false,
    hideControlLabel,
    hideLabel,
    lines = CLAMP_LINES,
    showControlLabel,
    showLabel,
    variant = "muted",
    ...unsafeProps
  }: ExpandableTextProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const textId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [cut, setCut] = useState(false);

  // Whether the text needs more than the clamp, measured again when the text
  // or its width changes. It reads the text's own line height, so it holds both
  // while the text is clamped and after it is shown whole.
  useLayoutEffect(() => {
    const text = root.current?.querySelector<HTMLElement>(".ui-text");
    if (!text) return;
    const measure = () => {
      const line = parseFloat(getComputedStyle(text).lineHeight);
      setCut(
        Number.isFinite(line)
          ? text.scrollHeight > lines * line + 1
          : text.scrollHeight > text.clientHeight + 1,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [children, expanded, lines]);

  return (
    <div
      className="ui-expandable-text"
      ref={root}
      {...props}
      data-cut={cut ? "true" : undefined}
      data-state={expanded ? "expanded" : "collapsed"}
      data-ui-component="expandableText"
      data-variant="default"
    >
      <Text
        id={textId}
        lines={expanded ? undefined : lines}
        variant={variant}
      >
        {children}
      </Text>
      {cut
        ? (
          <Button
            aria-controls={textId}
            aria-expanded={expanded}
            aria-label={expanded
              ? hideControlLabel ?? hideLabel
              : showControlLabel ?? showLabel}
            onClick={() => setExpanded((open) => !open)}
            variant="text"
          >
            {expanded ? hideLabel : showLabel}
          </Button>
        )
        : null}
    </div>
  );
}
