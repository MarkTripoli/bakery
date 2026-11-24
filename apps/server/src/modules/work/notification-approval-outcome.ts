import type { PgTransactionClient } from "../../platform/database.ts";

export type NotificationApprovalOutcome = {
  status:
    | "open"
    | "approved"
    | "changes_requested"
    | "rejected"
    | "expired"
    | "withdrawn";
  decidedBy: {
    principalId: string;
    displayName: string;
    avatarUrl: null;
  } | null;
  decidedAt: string | null;
};

type ApprovalOutcomeRow = {
  id: string;
  status: string;
  decision: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  revokedBy: string | null;
  revokedByName: string | null;
  revokedAt: Date | null;
};

const DECISION_STATUS: Record<
  string,
  NotificationApprovalOutcome["status"]
> = {
  approve: "approved",
  request_changes: "changes_requested",
  reject: "rejected",
};

function person(id: string | null, name: string | null) {
  return id === null
    ? null
    : { principalId: id, displayName: name ?? "Someone", avatarUrl: null };
}

function withoutDecider(
  status: NotificationApprovalOutcome["status"],
): NotificationApprovalOutcome {
  return { status, decidedBy: null, decidedAt: null };
}

export function approvalOutcomeOf(
  row: ApprovalOutcomeRow,
): NotificationApprovalOutcome {
  if (row.status === "revoked") {
    return {
      status: "withdrawn",
      decidedBy: person(row.revokedBy, row.revokedByName),
      decidedAt: row.revokedAt?.toISOString() ?? null,
    };
  }
  const decided = row.decision === null
    ? undefined
    : DECISION_STATUS[row.decision];
  if (decided !== undefined) {
    return {
      status: decided,
      decidedBy: person(row.decidedBy, row.decidedByName),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }
  if (row.status === "open") return withoutDecider("open");
  if (row.status === "expired") return withoutDecider("expired");
  return withoutDecider("withdrawn");
}

export async function readApprovalOutcomes(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: ReadonlyArray<{ targetKind: string; targetId: string }>,
): Promise<Map<string, NotificationApprovalOutcome>> {
  const ids = [
    ...new Set(
      rows.filter((row) => row.targetKind === "approval").map((row) =>
        row.targetId
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const found = await transaction.query<ApprovalOutcomeRow>(
    `select q.id,
       case when q.status = 'open' and q.expires_at is not null
         and q.expires_at <= now() then 'expired' else q.status end as status,
       q.decision, q.decided_by as "decidedBy",
       decider.display_name as "decidedByName", q.decided_at as "decidedAt",
       q.revoked_by as "revokedBy", revoker.display_name as "revokedByName",
       q.revoked_at as "revokedAt"
     from bakery.questions as q
     left join bakery.principals as decider on decider.id = q.decided_by
     left join bakery.principals as revoker on revoker.id = q.revoked_by
     where q.organization_id = $1::uuid and q.id = any($2::uuid[])
       and q.kind = 'approval'`,
    [organizationId, ids],
  );
  return new Map(found.rows.map((row) => [row.id, approvalOutcomeOf(row)]));
}
