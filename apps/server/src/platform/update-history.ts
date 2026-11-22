import { appendAudit } from "@bakery/persistence/event-audit";
import {
  UpdateFailurePolicy,
  UpdateFailurePolicySchema,
} from "@bakery/contracts/installation-settings";
import type { PgTransactionClient } from "./database.ts";

/**
 * The update policy and the update history (issue #59 slice 3, server asks 2,
 * 3, 7 and 14). Like pausing work (update-pause.ts), both are asked of the
 * database by the launcher as the database owner, never through Bakery's API:
 * an answer at the terminal is needed exactly when Bakery's own pages may be
 * broken. Bakery reads the history back for the Updates page.
 */

export const UPDATE_EVENT_OPERATION = "installation.update.event";

/** What happened to the installed version. Words, never a path or a secret. */
export const UpdateEventKind = Object.freeze(
  {
    /** The first release was installed. */
    Installed: "installed",
    /** An update replaced from_release with to_release. */
    Updated: "updated",
    /** A person went back by hand: from_release was replaced by to_release. */
    RolledBack: "rolled_back",
    /** The update to from_release did not become ready; Bakery returned to to_release. */
    WentBack: "went_back",
    /** The update to to_release was refused before anything changed. */
    Refused: "refused",
    /** A person at the terminal chose to go back from from_release to to_release. */
    DecidedGoBack: "decided_go_back",
    /** A person at the terminal chose to stay on the release that was not healthy. */
    DecidedStay: "decided_stay",
    /** A switch to from_release did not finish; recover put to_release back. */
    Interrupted: "interrupted",
  } as const,
);
export type UpdateEventKind =
  (typeof UpdateEventKind)[keyof typeof UpdateEventKind];

/** Events that move the installed version. */
export const MOVE_KINDS: readonly UpdateEventKind[] = [
  UpdateEventKind.Installed,
  UpdateEventKind.Updated,
  UpdateEventKind.RolledBack,
];

/**
 * Events a person is told about until they dismiss it. Leaving an unhealthy
 * release running (decided_stay, by a person or because no one could be asked)
 * is one: the installation is not healthy and an administrator has to act.
 */
export const FAILURE_KINDS: readonly UpdateEventKind[] = [
  UpdateEventKind.WentBack,
  UpdateEventKind.DecidedGoBack,
  UpdateEventKind.DecidedStay,
  UpdateEventKind.Interrupted,
];

/** One event, as the launcher sends it. */
export type UpdateEventInput = {
  /** Made by the launcher, so sending the same event again records it once. */
  readonly id: string;
  readonly kind: UpdateEventKind;
  readonly occurredAt: Date;
  /** The operating-system user at the terminal; null when Bakery did it by itself. */
  readonly byName: string | null;
  readonly fromRelease: string | null;
  readonly toRelease: string | null;
  /** The launcher's first line for a refusal. */
  readonly detail: string | null;
};

export type UpdatePolicy = { readonly onFailure: UpdateFailurePolicy };

type Query = Pick<PgTransactionClient, "query">;

/**
 * What to do when an update is not healthy. A missing or unreadable choice is
 * `go_back`: when nothing says to wait for a person, an unhealthy update is
 * undone by itself.
 */
export async function readUpdatePolicy(
  transaction: Query,
): Promise<UpdatePolicy> {
  const result = await transaction.query<{ policy: string }>(
    `select update_failure_policy as "policy"
       from bakery.installation_settings where id = true`,
  );
  const parsed = UpdateFailurePolicySchema.safeParse(result.rows[0]?.policy);
  return {
    onFailure: parsed.success ? parsed.data : UpdateFailurePolicy.GoBack,
  };
}

/**
 * Records one event for Bakery's update history. Sending the same id again
 * changes nothing and says so, because the launcher resends what it could not
 * record at once.
 */
export async function recordUpdateEvent(
  transaction: PgTransactionClient,
  input: UpdateEventInput,
): Promise<{ readonly recorded: boolean }> {
  const inserted = await transaction.query(
    `insert into bakery.installation_update_history
       (id, kind, occurred_at, by_name, from_release, to_release, detail)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [
      input.id,
      input.kind,
      input.occurredAt,
      input.byName,
      input.fromRelease,
      input.toRelease,
      input.detail,
    ],
  );
  const recorded = (inserted.rowCount ?? 0) > 0;
  if (recorded) {
    const requestId = `update:${input.id}`;
    await appendAudit(transaction, {
      organizationId: null,
      principalId: null,
      operation: UPDATE_EVENT_OPERATION,
      resourceType: "installation_update_history",
      resourceId: input.id,
      requestId,
      traceId: requestId,
      // Words and release ids only, like the pause's audit rows.
      details: {
        kind: input.kind,
        byName: input.byName,
        fromRelease: input.fromRelease,
        toRelease: input.toRelease,
      },
    });
  }
  return { recorded };
}
