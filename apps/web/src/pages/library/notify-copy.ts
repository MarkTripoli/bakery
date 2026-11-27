import type { MessageKey } from "@bakery/i18n";
import type { GroupsResponse } from "../../api/client.ts";
import type { ApprovalPerson } from "./approval-step.ts";
import type { NotifyFields } from "./notify-step.ts";

export type Translate = (
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

export type NotifyChoice = Readonly<
  { value: string; label: string; name?: string }
>;

export function notifyChoices(
  groups: GroupsResponse | undefined,
  people: readonly ApprovalPerson[],
  translate: Translate,
): readonly NotifyChoice[] {
  return [
    {
      value: "run:starter",
      label: translate("library.editor.notify.who.starter"),
      name: translate("library.editor.notify.who.starterName"),
    },
    {
      value: "run:task_owner",
      label: translate("library.editor.notify.who.taskOwner"),
      name: translate("library.editor.notify.who.taskOwnerName"),
    },
    ...(groups?.groups ?? []).map((group) => ({
      value: `group:${group.id}`,
      name: group.name,
      label: translate("library.editor.notify.who.group", {
        name: group.name,
        count: group.memberCount,
      }),
    })),
    ...(groups?.fromRoles ?? []).map((role) => ({
      value: `role:${role.roleKey}`,
      name: role.name,
      label: translate("library.editor.notify.who.group", {
        name: role.name,
        count: role.memberCount,
      }),
    })),
    ...people.filter((person) => person.active).map((person) => ({
      value: `person:${person.principalId}`,
      label: person.displayName,
    })),
  ];
}

export function whoName(
  who: string,
  choices: readonly NotifyChoice[],
  translate: Translate,
): string {
  const found = choices.find((choice) => choice.value === who);
  return found?.name ?? found?.label ??
    translate("library.editor.notify.who.gone");
}

export function afterName(hours: number, translate: Translate): string {
  return hours % 24 === 0
    ? translate("library.editor.notify.after.days", { count: hours / 24 })
    : translate("library.editor.notify.after.hours", { count: hours });
}

export function notifyCardLine(
  fields: NotifyFields,
  choices: readonly NotifyChoice[],
  translate: Translate,
): string {
  const who = whoName(fields.who, choices, translate);
  if (fields.need === "fyi") {
    return translate("library.editor.notify.card.fyi", { who });
  }
  if (!fields.wait) {
    return translate("library.editor.notify.card.review", { who });
  }
  if (fields.next === null || fields.next.who === "") {
    return translate("library.editor.notify.card.waits", { who });
  }
  return translate("library.editor.notify.card.next", {
    who,
    next: whoName(fields.next.who, choices, translate),
    time: afterName(fields.next.after, translate),
  });
}
