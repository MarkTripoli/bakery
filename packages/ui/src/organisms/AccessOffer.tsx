import { type HTMLAttributes, type ReactNode, useState } from "react";
import { Button } from "../atoms/Button.tsx";
import { IconButton } from "../atoms/IconButton.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

/** One person the offer would give access to, with the words for taking them out. */
export type AccessOfferPerson = {
  /** Stable id for the row and the `onRemove` call. */
  id: string;
  name: string;
  /** The remove button's accessible name, such as "Remove Ana Ruiz". */
  removeLabel: string;
};

export type AccessOfferProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "children">>
  & {
    /** The question, such as "Ana Ruiz can't see this document. Give them access?". */
    question: ReactNode;
    /** What the people would be able to do, and that nothing else is shared. */
    detail: ReactNode;
    /** More than one person: each is listed with a remove button. */
    people?: readonly AccessOfferPerson[];
    /** Called with a person's id when their remove button is pressed. */
    onRemove?: (id: string) => void;
    /** The words and action of "Don't mention {name}", for a single person. */
    decline?: { label: string; onDecline: () => void };
    /** The "Show all {n}" words for a list longer than five; the rest stay hidden until pressed. */
    showAllLabel?: string;
    /** A control that belongs in the block, such as the access level select for a document. */
    control?: ReactNode;
    /** `busy` while the send that gives the access is under way: the block is read-only. */
    state?: "default" | "busy";
  };

/** The most names shown before "Show all". */
const SHOWN = 5;

/**
 * The block under "Will be notified" that offers access to a mentioned person
 * who has none (design-ux #73 revision 3): the question, what they get, and the
 * way out. It never moves the draft or the caret. The yes is the send button
 * itself, so there is no second confirm here; the no removes the mention.
 */
export function AccessOffer(
  {
    control,
    decline,
    detail,
    onRemove,
    people,
    question,
    showAllLabel,
    state = "default",
    ...props
  }: AccessOfferProps,
) {
  const [all, setAll] = useState(false);
  const list = people ?? [];
  const shown = all || showAllLabel === undefined ? list : list.slice(0, SHOWN);
  return (
    <div
      className="ui-access-offer"
      role="status"
      {...props}
      aria-busy={state === "busy" || undefined}
      data-state={state}
      data-ui-component="accessOffer"
      data-variant="default"
    >
      <p className="ui-access-offer__question">{question}</p>
      <p className="ui-access-offer__detail">{detail}</p>
      {list.length > 1
        ? (
          <ul className="ui-access-offer__people">
            {shown.map((person) => (
              <li className="ui-access-offer__person" key={person.id}>
                <span>{person.name}</span>
                <IconButton
                  disabled={state === "busy"}
                  label={person.removeLabel}
                  onClick={() =>
                    onRemove?.(person.id)}
                  type="button"
                  variant="compact"
                >
                  <IconGlyph name="close" size="small" />
                </IconButton>
              </li>
            ))}
          </ul>
        )
        : null}
      {list.length > SHOWN && !all && showAllLabel !== undefined
        ? (
          <Button onClick={() => setAll(true)} type="button" variant="text">
            {showAllLabel}
          </Button>
        )
        : null}
      {control}
      {decline !== undefined
        ? (
          <Button
            disabled={state === "busy"}
            onClick={decline.onDecline}
            type="button"
            variant="text"
          >
            {decline.label}
          </Button>
        )
        : null}
    </div>
  );
}
