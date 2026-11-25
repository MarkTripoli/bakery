import type {
  TicketActionRef,
  TicketFamilyAction,
} from "@bakery/integration-sdk/provider";
import {
  TICKET_NOTE_ACTION,
  TICKET_NOTE_UPDATE_ACTION,
} from "../catalog/integration-providers/github.ts";

export type TicketFamilyActions = Readonly<
  Partial<Record<TicketFamilyAction, TicketActionRef>>
>;

const GITHUB_TICKET_ACTIONS: TicketFamilyActions = {
  "comment.create": TICKET_NOTE_ACTION,
  "comment.update": TICKET_NOTE_UPDATE_ACTION,
};

const DECLARED_TICKET_ACTIONS: Readonly<Record<string, TicketFamilyActions>> = {
  github: GITHUB_TICKET_ACTIONS,
};

export function ticketFamilyActionsOf(provider: string): TicketFamilyActions {
  return Object.hasOwn(DECLARED_TICKET_ACTIONS, provider)
    ? DECLARED_TICKET_ACTIONS[provider]
    : {};
}
