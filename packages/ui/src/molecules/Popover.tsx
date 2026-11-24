import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type PopoverProps =
  & Omit<SemanticNativeProps<HTMLAttributes<HTMLDivElement>>, "title">
  & {
    children: ReactNode;
    defaultOpen?: boolean;
    /** `toolbar` frames the trigger as a compact secondary button. */
    triggerAppearance?: "plain" | "toolbar";
    /**
     * Which edge of the trigger the content lines up with. `start` is right for
     * a trigger at the reading start; a trigger at the top bar's far end needs
     * `end`, or a 360px panel hangs past the viewport edge.
     */
    align?: "start" | "end";
    floating?: boolean;
    label: string;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
    trigger: ReactNode;
    /**
     * The trigger button's accessible name, for when the trigger draws a glyph
     * rather than words: without it the button announces nothing, and a screen
     * reader meets an unnamed control (#67 UX ruling 6934081003 fix 2).
     */
    triggerLabel?: string;
    /** The trigger's tooltip, for when its label is drawn as an icon alone. */
    triggerTitle?: string;
    variant?: "information" | "interactive";
  };

const REACHABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Shows compact secondary content from an explicit trigger. */
export function Popover(
  {
    align = "start",
    children,
    defaultOpen = false,
    floating = false,
    label,
    onOpenChange,
    open,
    trigger,
    triggerAppearance = "plain",
    triggerLabel,
    triggerTitle,
    variant = "information",
    ...unsafeProps
  }: PopoverProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const isOpen = open ?? uncontrolledOpen;
  const resolvedState = isOpen ? "open" : "closed";
  const setOpen = (nextOpen: boolean) => {
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) triggerRef.current?.focus();
  };
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    if (wasOpen.current && !isOpen) triggerRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen]);
  const leavesPanel = (event: KeyboardEvent) => {
    const content = contentRef.current;
    const active = globalThis.document.activeElement;
    if (!content || !active || !content.contains(active)) return false;
    const reachable = [
      ...content.querySelectorAll<HTMLElement>(REACHABLE),
    ];
    const edge = event.shiftKey
      ? (reachable[0] ?? content)
      : (reachable[reachable.length - 1] ?? content);
    return active === edge || (event.shiftKey && active === content);
  };

  useEffect(() => {
    if (!isOpen) return;
    contentRef.current?.focus();
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpenRef.current(false);
        }
        if (event.key === "Tab" && floating && leavesPanel(event)) {
          event.preventDefault();
          setOpenRef.current(false);
        }
        return;
      }
      if (
        !contentRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) setOpenRef.current(false);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [isOpen, floating]);

  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  useEffect(() => {
    if (!isOpen || !floating) return;
    let frame = 0;
    const GAP = 8;
    const place = () => {
      const content = contentRef.current;
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (content && anchor) {
        const boundaryEl = triggerRef.current?.closest(
          "[data-popover-boundary]",
        );
        const edge = boundaryEl?.getBoundingClientRect();
        const left = Math.max(edge?.left ?? 0, 0);
        const right = Math.min(edge?.right ?? Infinity, globalThis.innerWidth);
        const top = Math.max(edge?.top ?? 0, 0);
        const bottom = Math.min(
          edge?.bottom ?? Infinity,
          globalThis.innerHeight,
        );
        const frameSize = content.offsetHeight - content.clientHeight;
        const wanted = content.scrollHeight + frameSize;
        const below = bottom - anchor.bottom - GAP;
        const above = anchor.top - top - GAP;
        const opensBelow = wanted <= below ||
          (wanted > above && below >= above);
        const room = Math.max(Math.floor(opensBelow ? below : above), 0);
        const height = Math.min(wanted, room);
        const width = content.offsetWidth;
        const x = Math.min(
          Math.max(anchor.left, left + GAP),
          Math.max(right - width - GAP, left + GAP),
        );
        const y = opensBelow ? anchor.bottom + GAP : anchor.top - GAP - height;
        setFloatingStyle((was) => {
          const next: CSSProperties = {
            position: "fixed",
            left: Math.round(x),
            top: Math.round(y),
            maxBlockSize: room,
            visibility: "visible",
          };
          return was.left === next.left && was.top === next.top &&
              was.maxBlockSize === next.maxBlockSize &&
              was.visibility === next.visibility
            ? was
            : next;
        });
      }
      frame = globalThis.requestAnimationFrame(place);
    };
    place();
    return () => globalThis.cancelAnimationFrame(frame);
  }, [isOpen, floating]);

  /**
   * How much room the content really has, measured rather than guessed.
   *
   * The content is anchored under its trigger, so CSS alone cannot know where
   * that is: the difference between the viewport height and the content's own
   * `top` is the only honest cap. A previous fixed subtraction guessed wrong at
   * different scroll positions and let the content run past the bottom (#67 UX
   * round 4, item 2: a 1090px page in a 900px viewport). When the space below
   * is too small to be useful the content opens above its trigger instead.
   */
  useEffect(() => {
    if (!isOpen || floating) return;
    const content = contentRef.current;
    if (!content) return;
    const MIN_USEFUL_ROOM = 320;
    const place = () => {
      // Measured from the trigger, not the content: once the content opens above
      // its trigger its own top moves, and the room below would no longer be
      // the room it has.
      const anchor = triggerRef.current?.getBoundingClientRect();
      const rect = content.getBoundingClientRect();
      const below = Math.max(
        globalThis.innerHeight - (anchor?.bottom ?? rect.top) - 24,
        0,
      );
      const above = Math.max((anchor?.top ?? 0) - 24, 0);
      content.dataset.flip = below < MIN_USEFUL_ROOM ? "true" : "false";
      // Only a popover whose styles open it above on a flip has the room above;
      // every other one still opens below and keeps the room below.
      const placed = content.getBoundingClientRect();
      const opensAbove = content.dataset.flip === "true" &&
        above > below && anchor !== undefined &&
        placed.bottom <= anchor.top + 1;
      // Written inline: `max-block-size` is a physical-agnostic length the CSS
      // rail only lets a stylesheet take from a declared design token, and this
      // value is a measurement, not a token.
      content.style.maxBlockSize = `${
        Math.floor(opensAbove ? above : below)
      }px`;
    };
    place();
    globalThis.addEventListener("resize", place);
    globalThis.addEventListener("scroll", place, true);
    return () => {
      globalThis.removeEventListener("resize", place);
      globalThis.removeEventListener("scroll", place, true);
    };
  }, [isOpen, floating]);

  const panel = isOpen
    ? (
      <div
        aria-label={label}
        className={[
          "ui-popover__content",
          `ui-popover__content--${variant}`,
          "nowheel",
          "nopan",
        ].filter(Boolean).join(" ")}
        data-floating={floating ? "true" : undefined}
        id={contentId}
        ref={contentRef}
        role="dialog"
        style={floating ? floatingStyle : undefined}
        tabIndex={-1}
        {...props}
      >
        {children}
      </div>
    )
    : null;

  return (
    <span
      className="ui-popover"
      data-align={align}
      data-state={resolvedState}
      data-variant={variant}
      data-ui-component="popover"
    >
      <button
        aria-expanded={isOpen}
        aria-label={triggerLabel ??
          (typeof trigger === "string" ? undefined : label)}
        aria-controls={contentId}
        aria-haspopup="dialog"
        className={`ui-popover__trigger ui-popover__trigger--${triggerAppearance}`}
        onClick={() => setOpen(!isOpen)}
        ref={triggerRef}
        title={triggerTitle}
        type="button"
      >
        {trigger}
      </button>
      {floating && panel !== null ? createPortal(panel, document.body) : panel}
    </span>
  );
}
