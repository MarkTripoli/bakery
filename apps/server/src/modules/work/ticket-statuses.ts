export type TicketStatusChange = {
  organizationId: string;
  actorPrincipalId: string;
  provider: string;
  connectionId: string;
  resourceId: string;
  issueNumber: number;
  statusId: string;
  idempotencyKey: string;
  signal: AbortSignal;
};

export type TicketStatusResult =
  | { kind: "set" }
  | { kind: "failed"; problemCode: string };

export type TicketStatusWriter = {
  set(change: TicketStatusChange): Promise<TicketStatusResult>;
};
