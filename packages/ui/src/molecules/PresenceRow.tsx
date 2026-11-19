import type { HTMLAttributes } from "react";
import { Avatar } from "../atoms/Avatar.tsx";
import { IconGlyph, type IconGlyphName } from "../atoms/IconGlyph.tsx";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../collaboration.css";

/** One participant of a shared document. Agents and services are named as such by the caller. */
export type PresencePerson = {
  readonly id: string;
  readonly name: string;
  readonly kind: "person" | "agent" | "service";
  readonly src?: string;
  /**
   * Which of the six presence colours is theirs for the session (1 to 6), the
   * same one as their caret in the editor. Omit it and no ring is drawn.
   */
  readonly color?: 1 | 2 | 3 | 4 | 5 | 6;
};

/** Where this person's own changes stand. */
export type PresenceSaveState =
  | "saved"
  | "sending"
  | "offline"
  | "catching-up"
  | "refused";

export type PresenceRowProps =
  & Omit<
    SemanticNativeProps<Omit<HTMLAttributes<HTMLDivElement>, "children">>,
    "role"
  >
  & {
    /** The group's accessible name ("People in this document"), already translated. */
    "aria-label": string;
    /** Everyone here, in the order to show them. */
    people: readonly PresencePerson[];
    /** At most this many avatars are drawn; the rest are counted. Five by default. */
    maxVisible?: number;
    /** The accessible name of the "+n" count, already composed ("2 more people"). */
    overflowLabel: string;
    /** The one text line, already composed ("Ana is typing · Ben is viewing"). */
    status: string;
    /** Omitted, with saveLabel, where nothing will be saved any more (access removed). */
    saveState?: PresenceSaveState;
    /** The save state in words ("All changes saved"), already translated. */
    saveLabel?: string;
  };

const SAVE_GLYPH: Record<PresenceSaveState, IconGlyphName> = {
  saved: "check",
  sending: "refresh",
  offline: "alert",
  "catching-up": "refresh",
  refused: "caution",
};

const SAVE_TONE: Record<PresenceSaveState, "muted" | "warning" | "error"> = {
  saved: "muted",
  sending: "muted",
  offline: "warning",
  "catching-up": "muted",
  refused: "error",
};

/**
 * Who is editing a shared document, what they are doing, and where this
 * person's own changes stand. The save state is a polite live region, so a
 * change to it is announced once and never repeated while it holds.
 */
export function PresenceRow(
  {
    maxVisible = 5,
    overflowLabel,
    people,
    saveLabel,
    saveState,
    status,
    ...props
  }: PresenceRowProps,
) {
  const shown = people.slice(0, maxVisible);
  const hidden = people.length - shown.length;
  return (
    <div
      className="ui-presence-row"
      {...props}
      data-state={saveState}
      data-ui-component="presenceRow"
      data-variant="default"
      role="group"
    >
      <span className="ui-presence-row__people">
        {shown.map((person) => (
          <Avatar
            alt={person.name}
            data-kind={person.kind}
            data-presence-color={person.color}
            fallback={person.kind === "person"
              ? undefined
              : <IconGlyph name="terminal" size="small" />}
            key={person.id}
            size="small"
            src={person.src}
          />
        ))}
        {hidden > 0
          ? (
            <span
              aria-label={overflowLabel}
              className="ui-presence-row__more"
              role="img"
            >
              +{hidden}
            </span>
          )
          : null}
      </span>
      <span className="ui-presence-row__status">{status}</span>
      {saveState !== undefined && saveLabel !== undefined
        ? (
          <span
            className="ui-presence-row__save"
            data-tone={SAVE_TONE[saveState]}
            role="status"
          >
            <IconGlyph name={SAVE_GLYPH[saveState]} size="small" />
            <span>{saveLabel}</span>
          </span>
        )
        : null}
    </div>
  );
}
