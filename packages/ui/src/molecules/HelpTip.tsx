import {
  type ButtonHTMLAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { IconButton } from "../atoms/IconButton.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../feedback.css";

export type HelpTipProps =
  & SemanticNativeProps<
    Omit<
      ButtonHTMLAttributes<HTMLButtonElement>,
      | "aria-describedby"
      | "aria-label"
      | "children"
      | "onBlur"
      | "onClick"
      | "onFocus"
      | "onKeyDown"
      | "onPointerEnter"
      | "onPointerLeave"
      | "title"
      | "type"
    >
  >
  & {
    /** The help text. It describes the button; it is never the only way to do the task. */
    children: string;
    /** The accessible name of the close button shown on a phone. */
    closeLabel?: string;
    /** The button's accessible name, such as "About enforcement". */
    label: string;
  };

/**
 * Explains the label it sits after: an information button that shows its help
 * text on hover, on keyboard focus and on a tap. From 744px up the text is a
 * tooltip anchored to the start of the button, at most 320px wide. Below that
 * it is a panel pinned to the bottom of the screen, because a floating tooltip
 * cannot stay inside a narrow screen for every button position: the panel's
 * first line is the button's label and it has a close button. Escape, leaving
 * the button, a tap elsewhere and (on a phone) scrolling close it. It is help,
 * not a dialog: no backdrop, no focus trap, focus stays on the button.
 */
export function HelpTip(
  { children, closeLabel = "Close help", label, ...unsafeProps }: HelpTipProps,
) {
  const props = withoutSemanticOwnerProps(unsafeProps);
  const id = useId();
  const textId = `${id}-text`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || focused || tapped);

  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setHovered(false);
        setTapped(false);
        setDismissed(true);
      }
    };
    const scrolled = () => {
      if (globalThis.matchMedia("(max-width: 743px)").matches) {
        setDismissed(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    globalThis.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      globalThis.removeEventListener("scroll", scrolled, true);
    };
  }, [open]);

  const restoringFocus = useRef(false);
  const close = () => {
    setDismissed(true);
    setTapped(false);
    // Focus stays on the help button, and returning it there does not reopen the text.
    restoringFocus.current = true;
    rootRef.current?.querySelector("button")?.focus();
    restoringFocus.current = false;
  };

  return (
    <span
      className="ui-help-tip"
      data-state={open ? (focused ? "focus" : "open") : "closed"}
      data-ui-component="helpTip"
      data-variant="default"
      onBlur={(event: FocusEvent<HTMLSpanElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
          setTapped(false);
        }
      }}
      onFocus={() => {
        setFocused(true);
        if (!restoringFocus.current) setDismissed(false);
      }}
      onPointerEnter={(event: PointerEvent<HTMLSpanElement>) => {
        if (event.pointerType === "touch") return;
        setDismissed(false);
        setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      ref={rootRef}
    >
      <IconButton
        {...props}
        aria-describedby={textId}
        label={label}
        onClick={() => {
          setDismissed(false);
          setTapped((current) => !current);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setDismissed(true);
          }
        }}
        variant="compact"
      >
        <IconGlyph name="info" size="small" />
      </IconButton>
      <span className="ui-help-tip__panel">
        <span className="ui-help-tip__head">
          <span className="ui-help-tip__title">{label}</span>
          <IconButton label={closeLabel} onClick={close} variant="compact">
            <span aria-hidden="true">×</span>
          </IconButton>
        </span>
        <span className="ui-help-tip__text" id={textId} role="tooltip">
          {children}
        </span>
      </span>
    </span>
  );
}
