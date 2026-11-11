import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { Person } from "./model.ts";

export type ParticipantsProps = Readonly<{
  people: readonly Person[];
}>;

/**
 * Who is in this shared conversation: an avatar and name per person. The
 * current principal is marked, so a teammate's message is never mistaken for
 * the reader's own.
 */
export function Participants({ people }: ParticipantsProps) {
  const { translate: t } = useI18n();
  if (people.length === 0) return null;
  return (
    <UI.PaneSection
      ruled
      data-ui-region="participants"
      title={t("tasks.conversation.participants.heading", {
        count: String(people.length),
      })}
    >
      <UI.Stack
        gap="standard"
        role="list"
        aria-label={t("tasks.conversation.participants.label")}
      >
        {people.map((person) => (
          <UI.Inline
            gap="standard"
            key={person.id}
            role="listitem"
            data-participant-id={person.id}
          >
            <UI.Avatar
              alt={person.name}
              size="small"
              data-you={person.you ? "true" : undefined}
            />
            <UI.Text>
              {person.you
                ? t("tasks.conversation.participants.you", {
                  name: person.name,
                })
                : person.name}
            </UI.Text>
          </UI.Inline>
        ))}
      </UI.Stack>
    </UI.PaneSection>
  );
}
