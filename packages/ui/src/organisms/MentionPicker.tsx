import type { HTMLAttributes, ReactNode } from "react";
import { Avatar } from "../atoms/Avatar.tsx";
import { Badge } from "../atoms/Badge.tsx";
import { Button } from "../atoms/Button.tsx";
import { Skeleton } from "../atoms/Skeleton.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

/** One person in the list: what the caller knows, and what the row says about them. */
export type MentionPickerOption = {
  /** Stable id; the option's DOM id is built from it. */
  id: string;
  name: string;
  /** The accessible name, including the state ("Sam Patel, gets access on send"). */
  label: string;
  /** `ready` is the quiet normal row; `gains` carries a badge. Anyone listed can be chosen. */
  kind: "ready" | "gains";
  /** The badge words for a `gains` row. */
  note?: string;
};

export type MentionPickerProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "onSelect">>
  & {
    /** The listbox's id: the text field points at it with `aria-controls`. */
    listId: string;
    /** Names the list for assistive technology. */
    label: string;
    options: readonly MentionPickerOption[];
    /** The highlighted option's id; the field's `aria-activedescendant` is its DOM id. */
    activeId?: string | null;
    onChoose: (id: string) => void;
    /** What the body shows: the rows, skeleton rows, a plain sentence, or the failure and its retry. */
    state?: "options" | "loading" | "empty" | "error" | "limit";
    /** The sentence for `empty`, `error` and `limit`. */
    message?: ReactNode;
    /** The retry button's words and action for `error`. */
    retry?: { label: string; onRetry: () => void };
    /** Called when the list is scrolled to its end, so the caller can read the next page. */
    onEnd?: () => void;
    /** One line under the rows, such as who a person who gets access can reach. */
    footer?: ReactNode;
  };

/** The DOM id of one option, for `aria-activedescendant`. */
export function mentionOptionId(listId: string, id: string): string {
  return `${listId}-${id}`;
}

/**
 * The list of people a writer may mention, hung above a text field. A listbox
 * the field owns: the field keeps focus and points at the highlighted option.
 * The ordinary row is quiet, and only the exception (no access yet) wears a
 * badge; everyone listed can be chosen.
 */
export function MentionPicker(
  {
    activeId = null,
    footer,
    label,
    listId,
    message,
    onChoose,
    onEnd,
    options,
    retry,
    state = "options",
    ...props
  }: MentionPickerProps,
) {
  return (
    <div
      className="ui-mention-picker"
      {...props}
      data-state={state}
      data-ui-component="mentionPicker"
      data-variant="default"
    >
      {state === "options"
        ? (
          <ul
            aria-label={label}
            className="ui-mention-picker__list"
            id={listId}
            onScroll={(event) => {
              const list = event.currentTarget;
              if (
                onEnd !== undefined &&
                list.scrollTop + list.clientHeight >= list.scrollHeight - 24
              ) onEnd();
            }}
            role="listbox"
          >
            {options.map((option) => (
              <li
                aria-label={option.label}
                aria-selected={option.id === activeId}
                className="ui-mention-picker__option"
                data-kind={option.kind}
                id={mentionOptionId(listId, option.id)}
                key={option.id}
                // The field keeps focus: a press must not move it to the row.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(option.id)}
                role="option"
              >
                <Avatar alt={option.name} size="small" />
                <span className="ui-mention-picker__name">{option.name}</span>
                {option.kind === "gains" && option.note !== undefined
                  ? <Badge tone="warning">{option.note}</Badge>
                  : null}
              </li>
            ))}
          </ul>
        )
        : state === "loading"
        ? (
          <div aria-busy="true" className="ui-mention-picker__rows">
            <Skeleton shape="row" />
            <Skeleton shape="row" />
            <Skeleton shape="row" />
          </div>
        )
        : (
          <div className="ui-mention-picker__message" role="status">
            <span>{message}</span>
            {state === "error" && retry !== undefined
              ? (
                <Button onClick={retry.onRetry} variant="text">
                  {retry.label}
                </Button>
              )
              : null}
          </div>
        )}
      {footer ? <p className="ui-mention-picker__footer">{footer}</p> : null}
    </div>
  );
}
