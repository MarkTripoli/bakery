/**
 * Persistence for verified Slack identity links (`external_identity_links`).
 *
 * A row says: the Slack user who completed Sign in with Slack for this
 * organization is this principal. The proof itself (the id token) is checked
 * by `slack-identity.ts` before anything here is called and is never stored;
 * a row holds identifiers and times only.
 *
 * Every function takes the caller's transaction and returns a result with a
 * reason code, never an exception for an expected refusal, and none of them
 * puts a name, an email or a token in a result or a reason. Ids are checked
 * before the database is touched.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import {
  isSlackAppId,
  isSlackTeamId,
  isSlackUserId,
  type SlackIdentityLink,
  type SlackSubject,
} from "./slack-scope.ts";

/** The provider column value for every row this module writes. */
export const SLACK_LINK_PROVIDER = "slack";

/** How the link was proven; the id token itself is never kept. */
export const SLACK_LINK_VERIFICATION = "sign_in_with_slack_oidc";

const DEFAULT_RECONCILE_LIMIT = 100;
const MAX_RECONCILE_LIMIT = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a link was revoked. */
export type SlackLinkRevokeReason =
  | "revoked_by_admin"
  | "unlinked_by_member"
  | "membership_inactive";

const REVOKE_REASONS: ReadonlySet<string> = new Set<SlackLinkRevokeReason>([
  "revoked_by_admin",
  "unlinked_by_member",
  "membership_inactive",
]);

/** The three ids that identify a Slack user within one organization. */
export type SlackLinkIdentity = {
  readonly appId: string;
  readonly teamId: string;
  readonly userId: string;
};

/** A stored link, as a caller may see it. */
export type SlackIdentityLinkRecord = {
  readonly id: string;
  readonly principalId: string;
  readonly state: "active" | "revoked";
  readonly verifiedAt: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: SlackLinkRevokeReason | null;
  readonly version: number;
};

type LinkRow = {
  id: string;
  principalId: string;
  state: "active" | "revoked";
  verifiedAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: SlackLinkRevokeReason | null;
  version: number;
  holderCurrent: boolean;
};

const COLUMNS = `link.id, link.principal_id as "principalId", link.state,
  link.verified_at as "verifiedAt", link.revoked_at as "revokedAt",
  link.revoked_by as "revokedBy", link.revoke_reason as "revokeReason",
  link.version`;

const record = (row: LinkRow): SlackIdentityLinkRecord => ({
  id: row.id,
  principalId: row.principalId,
  state: row.state,
  verifiedAt: row.verifiedAt.toISOString(),
  revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  revokedBy: row.revokedBy,
  revokeReason: row.revokeReason,
  version: row.version,
});

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

function validIdentity(identity: unknown): identity is SlackLinkIdentity {
  if (typeof identity !== "object" || identity === null) return false;
  const value = identity as Record<string, unknown>;
  return isSlackAppId(value.appId) && isSlackTeamId(value.teamId) &&
    isSlackUserId(value.userId);
}

export type LinkSlackIdentityResult =
  | {
    readonly ok: true;
    /**
     * `linked`: a new row. `unchanged`: this member already held it.
     * `relinked`: a revoked row, or one whose holder was no longer a current
     * member, now belongs to this member.
     */
    readonly outcome: "linked" | "unchanged" | "relinked";
    readonly link: SlackIdentityLinkRecord;
  }
  | {
    readonly ok: false;
    readonly reason:
      | "malformed"
      | "not_a_member"
      | "linked_to_another_member";
  };

/**
 * Links a verified Slack identity to a current member. The caller has already
 * verified the identity token; this decides whether the member may hold it.
 *
 * - Only a current (active) member can hold a link.
 * - An identity held by another current member stays with them.
 * - A revoked link, or one whose holder is no longer a current member, is
 *   taken over by the member who has just proven the identity.
 */
export async function linkSlackIdentity(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly identity: SlackLinkIdentity;
    readonly verifiedAt: Date;
  },
): Promise<LinkSlackIdentityResult> {
  const { organizationId, principalId, identity, verifiedAt } = input;
  if (
    !isUuid(organizationId) || !isUuid(principalId) ||
    !validIdentity(identity) || !(verifiedAt instanceof Date) ||
    Number.isNaN(verifiedAt.getTime())
  ) return { ok: false, reason: "malformed" };

  // No lock on the membership: the foreign key on the insert below takes a
  // key-share lock on the row, which is what stops a concurrent removal.
  const member = await transaction.query(
    `select 1 from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2 and status = 'active'`,
    [organizationId, principalId],
  );
  if (member.rows.length !== 1) return { ok: false, reason: "not_a_member" };

  const inserted = await transaction.query<LinkRow>(
    `insert into bakery.external_identity_links as link (
       id, organization_id, principal_id, provider, external_app_id,
       identity_scope, external_user_id, verification_method, verified_at, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
     on conflict (organization_id, provider, external_app_id, identity_scope,
       external_user_id) do nothing
     returning ${COLUMNS}, true as "holderCurrent"`,
    [
      crypto.randomUUID(),
      organizationId,
      principalId,
      SLACK_LINK_PROVIDER,
      identity.appId,
      identity.teamId,
      identity.userId,
      SLACK_LINK_VERIFICATION,
      verifiedAt,
    ],
  );
  if (inserted.rows.length === 1) {
    return { ok: true, outcome: "linked", link: record(inserted.rows[0]!) };
  }

  // The identity already has a row, possibly one a concurrent transaction has
  // only just committed (the insert waited for it). Lock it and decide.
  const existing = await transaction.query<LinkRow>(
    `select ${COLUMNS},
            coalesce(membership.status = 'active', false) as "holderCurrent"
       from bakery.external_identity_links as link
       left join bakery.organization_memberships as membership
         on membership.organization_id = link.organization_id
        and membership.principal_id = link.principal_id
      where link.organization_id = $1 and link.provider = $2
        and link.external_app_id = $3 and link.identity_scope = $4
        and link.external_user_id = $5
        for update of link`,
    [
      organizationId,
      SLACK_LINK_PROVIDER,
      identity.appId,
      identity.teamId,
      identity.userId,
    ],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    return { ok: false, reason: "linked_to_another_member" };
  }

  if (row.state === "active" && row.principalId === principalId) {
    return { ok: true, outcome: "unchanged", link: record(row) };
  }
  if (row.state === "active" && row.holderCurrent) {
    return { ok: false, reason: "linked_to_another_member" };
  }

  const relinked = await transaction.query<LinkRow>(
    `update bakery.external_identity_links as link
        set principal_id = $2, state = 'active', verification_method = $3,
            verified_at = $4, revoked_at = null, revoked_by = null,
            revoke_reason = null, updated_at = now(), version = link.version + 1
      where link.id = $1
      returning ${COLUMNS}, true as "holderCurrent"`,
    [row.id, principalId, SLACK_LINK_VERIFICATION, verifiedAt],
  );
  return { ok: true, outcome: "relinked", link: record(relinked.rows[0]!) };
}

/**
 * The stored link for a Slack identity in one organization, in the shape
 * `resolveSlackActor` expects. `memberCurrent` is read now, so a member made
 * inactive stops being a human at once, before any sweep has run.
 */
export async function findSlackIdentityLink(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string } & SlackLinkIdentity,
): Promise<SlackIdentityLink | undefined> {
  if (!isUuid(input.organizationId) || !validIdentity(input)) return undefined;
  const result = await transaction.query<
    { principalId: string; state: "active" | "revoked"; memberCurrent: boolean }
  >(
    `select link.principal_id as "principalId", link.state,
            coalesce(membership.status = 'active', false) as "memberCurrent"
       from bakery.external_identity_links as link
       left join bakery.organization_memberships as membership
         on membership.organization_id = link.organization_id
        and membership.principal_id = link.principal_id
      where link.organization_id = $1 and link.provider = $2
        and link.external_app_id = $3 and link.identity_scope = $4
        and link.external_user_id = $5`,
    [
      input.organizationId,
      SLACK_LINK_PROVIDER,
      input.appId,
      input.teamId,
      input.userId,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : {
    principalId: row.principalId,
    state: row.state,
    memberCurrent: row.memberCurrent,
  };
}

/**
 * The lookup `resolveSlackActor` takes, bound to a transaction and an
 * organization. A subject that does not name its app finds nothing: a link is
 * unique per app, and guessing one would let a user of one app act through
 * another's link.
 */
export function slackLinkLookup(
  transaction: PgTransactionClient,
  organizationId: string,
): (subject: SlackSubject) => Promise<SlackIdentityLink | undefined> {
  return (subject) =>
    subject.appId === undefined
      ? Promise.resolve(undefined)
      : findSlackIdentityLink(transaction, {
        organizationId,
        appId: subject.appId,
        teamId: subject.teamId,
        userId: subject.userId,
      });
}

export type RevokeSlackIdentityResult =
  | { readonly ok: true; readonly link: SlackIdentityLinkRecord }
  | {
    readonly ok: false;
    readonly reason: "malformed" | "not_found" | "already_revoked";
  };

/**
 * Revokes one link of one organization. A link of another organization is
 * `not_found`, the same answer as a link that does not exist, so ids disclose
 * nothing across organizations.
 */
export async function revokeSlackIdentityLink(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly linkId: string;
    readonly revokedBy: string | null;
    readonly reason: SlackLinkRevokeReason;
    readonly at: Date;
  },
): Promise<RevokeSlackIdentityResult> {
  const { organizationId, linkId, revokedBy, reason, at } = input;
  if (
    !isUuid(organizationId) || !isUuid(linkId) ||
    (revokedBy !== null && !isUuid(revokedBy)) ||
    !REVOKE_REASONS.has(reason) || !(at instanceof Date) ||
    Number.isNaN(at.getTime())
  ) return { ok: false, reason: "malformed" };

  const current = await transaction.query<{ state: string }>(
    `select state from bakery.external_identity_links
      where organization_id = $1 and id = $2 for update`,
    [organizationId, linkId],
  );
  const row = current.rows[0];
  if (row === undefined) return { ok: false, reason: "not_found" };
  if (row.state === "revoked") return { ok: false, reason: "already_revoked" };

  const revoked = await transaction.query<LinkRow>(
    `update bakery.external_identity_links as link
        set state = 'revoked', revoked_at = $3, revoked_by = $4,
            revoke_reason = $5, updated_at = now(), version = link.version + 1
      where link.organization_id = $1 and link.id = $2
      returning ${COLUMNS}, false as "holderCurrent"`,
    [organizationId, linkId, at, revokedBy, reason],
  );
  return { ok: true, link: record(revoked.rows[0]!) };
}

/**
 * Revokes the active links of an organization whose member is no longer
 * active, at most `limit` of them, oldest first. Returns how many it revoked;
 * call again until it returns 0. A member removed outright takes their links
 * with them (the foreign key), so only inactive members arrive here.
 */
export async function reconcileSlackIdentityLinks(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly at: Date;
    readonly limit?: number;
  },
): Promise<{ readonly revoked: number }> {
  const { organizationId, at } = input;
  const limit = input.limit ?? DEFAULT_RECONCILE_LIMIT;
  if (
    !isUuid(organizationId) || !(at instanceof Date) ||
    Number.isNaN(at.getTime()) || !Number.isInteger(limit) || limit < 1 ||
    limit > MAX_RECONCILE_LIMIT
  ) return { revoked: 0 };

  const result = await transaction.query(
    `update bakery.external_identity_links as link
        set state = 'revoked', revoked_at = $2, revoked_by = null,
            revoke_reason = 'membership_inactive', updated_at = now(),
            version = link.version + 1
      where link.id in (
        select candidate.id from bakery.external_identity_links as candidate
          join bakery.organization_memberships as membership
            on membership.organization_id = candidate.organization_id
           and membership.principal_id = candidate.principal_id
         where candidate.organization_id = $1 and candidate.state = 'active'
           and membership.status <> 'active'
         order by candidate.created_at, candidate.id
         limit $3
           for update of candidate skip locked)`,
    [organizationId, at, limit],
  );
  return { revoked: result.rowCount ?? 0 };
}
