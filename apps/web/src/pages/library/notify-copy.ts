import type { MessageKey } from "@bakery/i18n";
import type { GroupsResponse } from "../../api/client.ts";
import type { ApprovalPerson } from "./approval-step.ts";
import type { NotifyFields } from "./notify-step.ts";

export type Translate = (
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

export type NotifyChoice = Readonly<
  { value: string; label: string; name?: string; gone?: boolean }
>;

export type ListState = "loading" | "failed" | "ready";

export type ListStates = Readonly<{ people: ListState; groups: ListState }>;

export function unknownWho(
  who: string,
  lists: ListStates,
  translate: Translate,
  placed: "alone" | "inSentence",
): string {
  const person = who.startsWith("person:");
  const state = person ? lists.people : lists.groups;
  if (state !== "ready") {
    return translate(
      state === "failed"
        ? "library.editor.notify.who.unread"
        : "library.editor.notify.who.loading",
    );
  }
  const kind = person ? "gone" : "goneGroup";
  return translate(
    placed === "alone"
      ? `library.editor.notify.who.${kind}`
      : `library.editor.notify.who.${kind}Name`,
  );
}

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
    ...people.map((person) => ({
      value: `person:${person.principalId}`,
      label: person.displayName,
      gone: !person.active,
    })),
  ];
}

export function whoName(
  who: string,
  choices: readonly NotifyChoice[],
  lists: ListStates,
  translate: Translate,
): string {
  const found = choices.find((choice) => choice.value === who);
  return found?.name ?? found?.label ??
    unknownWho(who, lists, translate, "inSentence");
}

export function whoIsKnown(
  who: string,
  choices: readonly NotifyChoice[],
  lists: ListStates,
): boolean {
  const state = who.startsWith("person:") ? lists.people : lists.groups;
  return state === "ready" || choices.some((choice) => choice.value === who);
}

export function afterName(hours: number, translate: Translate): string {
  return hours % 24 === 0
    ? translate("library.editor.notify.after.days", { count: hours / 24 })
    : translate("library.editor.notify.after.hours", { count: hours });
}

export function notifyCardLine(
  fields: NotifyFields,
  choices: readonly NotifyChoice[],
  lists: ListStates,
  translate: Translate,
): string | null {
  const next = fields.need === "review" && fields.wait && fields.next?.who
    ? fields.next
    : null;
  const asked = [fields.who, ...(next === null ? [] : [next.who])];
  if (!asked.every((who) => whoIsKnown(who, choices, lists))) return null;
  const who = whoName(fields.who, choices, lists, translate);
  if (fields.need === "fyi") {
    return translate("library.editor.notify.card.fyi", { who });
  }
  if (!fields.wait) {
    return translate("library.editor.notify.card.review", { who });
  }
  if (next === null) {
    return translate("library.editor.notify.card.waits", { who });
  }
  return translate("library.editor.notify.card.next", {
    who,
    next: whoName(next.who, choices, lists, translate),
    time: afterName(next.after, translate),
  });
}
