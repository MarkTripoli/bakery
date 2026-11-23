import type { HTMLAttributes } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { Button } from "../atoms/Button.tsx";
import { DataText } from "../atoms/DataText.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Link } from "../atoms/Link.tsx";
import { Text } from "../atoms/Text.tsx";
import { VisuallyHidden } from "../atoms/VisuallyHidden.tsx";
import { type ReferenceKind, shortReference } from "./reference-short.ts";
import "../reference.css";

export { type ReferenceKind, shortReference };

/** Every word the reference and its card say, already translated by the caller. */
export type ReferenceLabels = {
  /** The kind in words: "Commit", "Release". */
  readonly kind: string;
  readonly copy: string;
  readonly copied: string;
  /** Said when the clipboard refuses. */
  readonly copyFailed: string;
  /** Read by assistive technology after an outside link: "(opens in a new tab)". */
  readonly opensNewTab: string;
  /** Said in the card when the link opens outside Bakery: "Opens on GitHub in a new tab.". */
  readonly destination?: string;
};

export type ReferenceProps =
  & Omit<SemanticNativeProps<HTMLAttributes<HTMLSpanElement>>, "children">
  & {
    readonly kind: ReferenceKind;
    /** The whole id, number or name. It is what Copy copies and what the card shows. */
    readonly value: string;
    /** What shows in the text when it is not the kind's short form (a task's own reference, "#123"). */
    readonly label?: string;
    /** Where it goes. Without one the reference is plain text that can still be copied. */
    readonly href?: string;
    /** The destination is outside Bakery: a new tab, a small glyph and a spoken note. */
    readonly external?: boolean;
    readonly labels: ReferenceLabels;
    /** Punctuation that follows the reference in a sentence, such as a full stop: it never wraps away from it. */
    readonly trailing?: string;
    /** Opt-in, for specimens and tests: the card is open from the first render. */
    readonly defaultOpen?: boolean;
  };

/** How long the pointer rests on a reference before its card opens. */
const HOVER_OPEN_MS = 300;
/** The least room kept between an open card and what clips it, in pixels. */
const EDGE_GAP = 8;

/**
 * The left and right edges the card can be seen between: the window, narrowed
 * by every ancestor that clips sideways (a rail that scrolls or hides its
 * overflow). A card past such an edge is cut off even inside the window.
 */
function clipBounds(card: HTMLElement): readonly [number, number] {
  let left = 0;
  let right = globalThis.document.documentElement.clientWidth;
  for (
    let node = card.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    if (globalThis.getComputedStyle(node).overflowX === "visible") continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  return [left, right];
}
/** How long "Copied" stays. */
const COPIED_MS = 2500;

/**
 * An id, number or name that points at something: a link when it has a page,
 * plain text when it does not, and a card with the whole value and Copy when
 * the short form hides part of it.
 */
export function Reference(
  {
    kind,
    value,
    label,
    href,
    external = false,
    labels,
    trailing,
    defaultOpen = false,
    ...props
  }: ReferenceProps,
) {
  const shown = label ?? shortReference(kind, value);
  const hasCard = shown !== value;
  const linked = href !== undefined;
  const cardId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const cardEl = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timers = useRef<{
    hover?: ReturnType<typeof globalThis.setTimeout>;
    copied?: ReturnType<typeof globalThis.setTimeout>;
  }>({});

  useEffect(() => {
    const held = timers.current;
    return () => {
      globalThis.clearTimeout(held.hover);
      globalThis.clearTimeout(held.copied);
    };
  }, []);

  // The card opens under the reference and reads from its start. Where that
  // would run past the edge of what clips it (the window, or a rail that
  // scrolls), it is measured once it is in place and shifted back inside, and
  // narrowed when the room is smaller than the card. Written on the element,
  // not in state: a measurement must not render again. The phone sheet is
  // fixed to the window and sizes itself.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const card = cardEl.current;
      if (card === null) return;
      card.style.insetInlineStart = "";
      card.style.maxInlineSize = "";
      if (globalThis.getComputedStyle(card).position === "fixed") return;
      const [left, right] = clipBounds(card);
      const room = right - left - 2 * EDGE_GAP;
      let box = card.getBoundingClientRect();
      if (box.width > room) {
        card.style.maxInlineSize = `${Math.max(room, 0)}px`;
        box = card.getBoundingClientRect();
      }
      let shift = 0;
      if (box.right > right - EDGE_GAP) shift = right - EDGE_GAP - box.right;
      if (box.left + shift < left + EDGE_GAP) {
        shift = left + EDGE_GAP - box.left;
      }
      if (shift === 0) return;
      const rtl = globalThis.getComputedStyle(card).direction === "rtl";
      card.style.insetInlineStart = `${rtl ? -shift : shift}px`;
    };
    place();
    globalThis.addEventListener("resize", place);
    return () => globalThis.removeEventListener("resize", place);
  }, [open]);

  // A card that closes forgets it said Copied.
  useEffect(() => {
    if (!open) setCopy("idle");
  }, [open]);

  const copyValue = async () => {
    globalThis.clearTimeout(timers.current.copied);
    try {
      await globalThis.navigator.clipboard.writeText(value);
      setCopy("copied");
      timers.current.copied = globalThis.setTimeout(
        () => setCopy("idle"),
        COPIED_MS,
      );
    } catch {
      setCopy("failed");
    }
  };

  const text = linked
    ? (
      <Link
        href={href}
        rel={external ? "noreferrer" : undefined}
        target={external ? "_blank" : undefined}
        variant="sentence"
      >
        <DataText
          fit
          variant={kind === "machine" || kind === "person"
            ? "code"
            : "identifier"}
        >
          {shown}
        </DataText>
        {external
          ? (
            <>
              <span className="ui-reference__glyph">
                <IconGlyph name="arrow" size="small" />
              </span>
              <VisuallyHidden>{` ${labels.opensNewTab}`}</VisuallyHidden>
            </>
          )
          : null}
      </Link>
    )
    : (
      <span
        className="ui-reference__plain"
        onClick={hasCard ? () => setOpen((now) => !now) : undefined}
        tabIndex={hasCard ? 0 : undefined}
      >
        <DataText fit variant="identifier">{shown}</DataText>
      </span>
    );

  return (
    <span
      {...props}
      className="ui-reference"
      data-kind={kind}
      data-linked={linked ? "true" : "false"}
      data-open={open ? "true" : "false"}
      data-state={open ? "open" : "default"}
      data-ui-component="reference"
      data-variant={kind}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      onFocus={(event) => {
        // Keyboard focus opens the card; a touch tap on a link just follows it.
        if (
          hasCard && (event.target as HTMLElement).matches(":focus-visible")
        ) setOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      onPointerEnter={(event) => {
        if (!hasCard || event.pointerType !== "mouse") return;
        globalThis.clearTimeout(timers.current.hover);
        timers.current.hover = globalThis.setTimeout(
          () => setOpen(true),
          HOVER_OPEN_MS,
        );
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        globalThis.clearTimeout(timers.current.hover);
        if (!root.current?.contains(globalThis.document.activeElement)) {
          setOpen(false);
        }
      }}
      ref={root}
    >
      {trailing === undefined || trailing === ""
        ? text
        : (
          <span className="ui-data-text-keep" data-trailing={trailing}>
            {text}
            {trailing}
          </span>
        )}
      {hasCard && open
        ? (
          <span
            aria-label={labels.kind}
            className="ui-reference__card"
            id={cardId}
            ref={cardEl}
            role="group"
          >
            <Text variant="caption">{labels.kind}</Text>
            <DataText variant="identifier">{value}</DataText>
            {external && labels.destination !== undefined
              ? <Text variant="caption">{labels.destination}</Text>
              : null}
            <span className="ui-reference__copy">
              <Button onClick={copyValue} variant="secondary">
                {copy === "copied" ? labels.copied : labels.copy}
              </Button>
            </span>
            {copy === "failed"
              ? <Text variant="caption">{labels.copyFailed}</Text>
              : null}
            <VisuallyHidden role="status">
              {copy === "copied"
                ? labels.copied
                : copy === "failed"
                ? labels.copyFailed
                : ""}
            </VisuallyHidden>
          </span>
        )
        : null}
    </span>
  );
}
