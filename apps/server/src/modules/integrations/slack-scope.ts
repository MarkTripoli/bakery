/**
 * What a Slack installation and a Slack user are allowed to be.
 *
 * Installing the bot in a workspace and a person proving who they are are two
 * separate authorities, and three mistakes would blur them: reading an
 * organization-wide installation as a workspace one, treating a channel the
 * admin did not select as available, and treating an unlinked Slack user as a
 * Bakery member. Each is decided here, as a plain function of its arguments,
 * so the decision can be tested without a database or a Slack workspace.
 *
 * Nothing here reads, stores or returns a token. An installation response
 * carries the bot token; classifying it keeps only the facts that identify the
 * installation, so the token cannot leak through a result, a reason or a log.
 */

/** Why an installation response was refused. A code only. */
export type SlackInstallationRejection =
  | "not_ok"
  | "wrong_app"
  | "organization_wide"
  | "malformed";

/** A supported installation: one workspace, with the bot. */
export type SlackInstallation = {
  readonly kind: "workspace";
  readonly appId: string;
  /** The verified workspace (`T...`). */
  readonly teamId: string;
  /** The Enterprise Grid organization the workspace belongs to, when it does. */
  readonly enterpriseId?: string;
  readonly botUserId: string;
  /** Granted bot scopes, de-duplicated and sorted. */
  readonly scopes: readonly string[];
};

export type SlackInstallationResult =
  | { readonly ok: true; readonly installation: SlackInstallation }
  | { readonly ok: false; readonly reason: SlackInstallationRejection };

const APP_ID = /^A[A-Z0-9]{2,31}$/;
const TEAM_ID = /^T[A-Z0-9]{2,31}$/;
const ENTERPRISE_ID = /^E[A-Z0-9]{2,31}$/;
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,31}$/;
/** Whether `value` is a Slack app id (`A...`), as a plain string. */
export const isSlackAppId = (value: unknown): value is string =>
  typeof value === "string" && APP_ID.test(value);

/** Whether `value` is a Slack workspace id (`T...`). */
export const isSlackTeamId = (value: unknown): value is string =>
  typeof value === "string" && TEAM_ID.test(value);

/** Whether `value` is a Slack user id (`U...` or `W...`). */
export const isSlackUserId = (value: unknown): value is string =>
  typeof value === "string" && USER_ID.test(value);

/**
 * A Slack scope: dot-separated parts, optionally followed by a colon and more
 * dot-separated parts, each part starting with a lowercase letter and then
 * lowercase letters, digits, underscores or hyphens. That covers `commands`,
 * `chat:write`, `chat:write.public`, `users:read.email`, `links.embed:write` and
 * `incoming-webhook`. Every `.` and `:` is a literal separator between parts that
 * cannot contain it, so the pattern cannot backtrack catastrophically.
 */
const SCOPE =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*(?::[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*)?$/;

/** Most scopes read from one response; a real bot has a dozen. */
const MAX_SCOPES = 100;

/** Longest single scope; real ones are under 40 characters. */
const MAX_SCOPE_LENGTH = 128;

/** The most a scope string can hold: the count, the length and the commas. */
const MAX_SCOPE_STRING_LENGTH = MAX_SCOPES * (MAX_SCOPE_LENGTH + 1);

const refuse = (
  reason: SlackInstallationRejection,
): SlackInstallationResult => ({
  ok: false,
  reason,
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Reads a Slack `oauth.v2.access` response for a bot installation. Only a
 * workspace installation of `expectedAppId` is accepted: an organization-wide
 * one is refused, and the capability stays unavailable. The response's
 * `access_token` is never read.
 */
export function classifySlackInstallation(
  response: unknown,
  expectedAppId: string,
): SlackInstallationResult {
  try {
    const body = record(response);
    if (!body) return refuse("malformed");
    if (typeof expectedAppId !== "string" || !APP_ID.test(expectedAppId)) {
      return refuse("wrong_app");
    }
    if (body.ok !== true) return refuse("not_ok");
    if (body.app_id !== expectedAppId) return refuse("wrong_app");

    // An organization-wide install is the only kind with a flag that is true;
    // a flag that is missing or anything but literally false is not a workspace
    // install, so the capability is not offered on a guess.
    if (body.is_enterprise_install !== false) {
      return refuse("organization_wide");
    }

    if (body.token_type !== "bot") return refuse("malformed");
    const team = record(body.team);
    if (!team || typeof team.id !== "string" || !TEAM_ID.test(team.id)) {
      return refuse("malformed");
    }
    let enterpriseId: string | undefined;
    if (body.enterprise !== null && body.enterprise !== undefined) {
      const enterprise = record(body.enterprise);
      if (
        !enterprise || typeof enterprise.id !== "string" ||
        !ENTERPRISE_ID.test(enterprise.id)
      ) return refuse("malformed");
      enterpriseId = enterprise.id;
    }
    if (
      typeof body.bot_user_id !== "string" || !USER_ID.test(body.bot_user_id)
    ) return refuse("malformed");

    if (typeof body.scope !== "string") return refuse("malformed");
    // Bounded before it is split or matched, so a huge string costs nothing.
    if (body.scope.length > MAX_SCOPE_STRING_LENGTH) return refuse("malformed");
    const listed = body.scope === "" ? [] : body.scope.split(",");
    if (listed.length > MAX_SCOPES) return refuse("malformed");
    if (
      listed.some((scope) =>
        scope.length > MAX_SCOPE_LENGTH || !SCOPE.test(scope)
      )
    ) return refuse("malformed");

    return {
      ok: true,
      installation: {
        kind: "workspace",
        appId: body.app_id,
        teamId: team.id,
        ...(enterpriseId === undefined ? {} : { enterpriseId }),
        botUserId: body.bot_user_id,
        scopes: [...new Set(listed)].sort(),
      },
    };
  } catch {
    return refuse("malformed");
  }
}

/**
 * The scopes each feature needs, matched whole. A feature is on only when
 * every scope it lists was granted; granting a scope never turns on a feature
 * that lists others as well.
 */
export const SLACK_FEATURE_SCOPES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    channel_picker: ["channels:read"],
    slash_commands: ["commands"],
    progress_posts: ["chat:write"],
    mentions: ["app_mentions:read"],
    linked_replies_public: ["channels:history"],
    linked_replies_private: ["groups:history"],
  });

/**
 * The features a set of granted scopes switches on. `table` is a seam: every
 * current feature needs a single scope, so only a table with a feature that
 * needs several can show that all of them are required.
 */
export function slackFeaturesFor(
  granted: readonly string[],
  table: Readonly<Record<string, readonly string[]>> = SLACK_FEATURE_SCOPES,
): string[] {
  if (!Array.isArray(granted)) return [];
  const have = new Set(granted.filter((scope) => typeof scope === "string"));
  return Object.entries(table)
    .filter(([, needs]) => needs.every((scope) => have.has(scope)))
    .map(([feature]) => feature);
}

/** The channels an admin selected, and whether private channels may take part. */
export type SlackChannelSelection = {
  readonly selectedChannelIds: ReadonlySet<string>;
  readonly privateParticipation: boolean;
};

export type SlackChannelFacts = {
  readonly id: unknown;
  readonly isPrivate: unknown;
  readonly botIsMember: unknown;
};

export type SlackChannelCapability =
  | { readonly available: true }
  | {
    readonly available: false;
    readonly reason:
      | "malformed"
      | "not_selected"
      | "private_not_enabled"
      | "bot_not_member";
  };

const unavailable = (
  reason: Exclude<SlackChannelCapability, { available: true }>["reason"],
): SlackChannelCapability => ({ available: false, reason });

/**
 * Whether Bakery may use a channel. A channel outside the admin's selection is
 * unavailable however Slack describes it, a private one also needs private
 * participation switched on, and the bot has to be in it. Anything that is not
 * plainly a channel is unavailable.
 */
export function channelCapability(
  selection: SlackChannelSelection,
  channel: SlackChannelFacts,
): SlackChannelCapability {
  try {
    if (
      !selection || !(selection.selectedChannelIds instanceof Set) ||
      typeof selection.privateParticipation !== "boolean"
    ) return unavailable("malformed");
    const facts = record(channel);
    if (
      !facts || typeof facts.id !== "string" || !CHANNEL_ID.test(facts.id) ||
      typeof facts.isPrivate !== "boolean" ||
      typeof facts.botIsMember !== "boolean"
    ) return unavailable("malformed");
    if (!selection.selectedChannelIds.has(facts.id)) {
      return unavailable("not_selected");
    }
    if (facts.isPrivate && !selection.privateParticipation) {
      return unavailable("private_not_enabled");
    }
    if (!facts.botIsMember) return unavailable("bot_not_member");
    return { available: true };
  } catch {
    return unavailable("malformed");
  }
}

/** A stored link between a Slack user and a Bakery principal. */
export type SlackIdentityLink = {
  readonly principalId: string;
  readonly state: "active" | "revoked";
  /** Whether that principal is a current member of the organization. */
  readonly memberCurrent: boolean;
};

/** The stable ids a link is looked up by, and nothing a person can choose. */
export type SlackSubject = {
  readonly teamId: string;
  readonly userId: string;
  readonly enterpriseId?: string;
  /**
   * The Slack app the event arrived through. A link is unique per app, so a
   * lookup that cannot name the app finds nothing rather than guessing one.
   */
  readonly appId?: string;
};

export type SlackActor =
  | { readonly kind: "human"; readonly principalId: string }
  | {
    readonly kind: "service";
    readonly verifiedHuman: false;
    readonly reason:
      | "malformed"
      | "unlinked"
      | "revoked"
      | "not_a_member"
      | "lookup_failed";
  };

const service = (
  reason: Extract<SlackActor, { kind: "service" }>["reason"],
): SlackActor => ({ kind: "service", verifiedHuman: false, reason });

/**
 * Who is acting when a Slack user sends something. A Slack user is a Bakery
 * member only through an active link whose principal is still a member; the
 * installation alone, a handle, a display name or an email resemblance prove
 * nothing. In every other case the actor is the service identity, which is
 * never a verified human. `lookup` receives the stable ids only.
 */
export async function resolveSlackActor(
  subject: SlackSubject,
  lookup: (key: SlackSubject) => Promise<SlackIdentityLink | undefined>,
): Promise<SlackActor> {
  try {
    const candidate = record(subject);
    if (
      !candidate || typeof candidate.teamId !== "string" ||
      !TEAM_ID.test(candidate.teamId) || typeof candidate.userId !== "string" ||
      !USER_ID.test(candidate.userId)
    ) return service("malformed");
    if (candidate.enterpriseId !== undefined) {
      if (
        typeof candidate.enterpriseId !== "string" ||
        !ENTERPRISE_ID.test(candidate.enterpriseId)
      ) return service("malformed");
    }
    if (candidate.appId !== undefined && !isSlackAppId(candidate.appId)) {
      return service("malformed");
    }
    const key: SlackSubject = {
      teamId: candidate.teamId,
      userId: candidate.userId,
      ...(candidate.enterpriseId === undefined
        ? {}
        : { enterpriseId: candidate.enterpriseId }),
      ...(candidate.appId === undefined ? {} : { appId: candidate.appId }),
    };
    if (typeof lookup !== "function") return service("lookup_failed");

    let found: unknown;
    try {
      found = await lookup(key);
    } catch {
      return service("lookup_failed");
    }
    if (found === undefined) return service("unlinked");
    const row = record(found);
    if (!row) return service("lookup_failed");
    if (row.state === "revoked") return service("revoked");
    if (row.state !== "active") return service("unlinked");
    if (row.memberCurrent !== true) return service("not_a_member");
    if (typeof row.principalId !== "string" || row.principalId.length === 0) {
      return service("lookup_failed");
    }
    return { kind: "human", principalId: row.principalId };
  } catch {
    return service("lookup_failed");
  }
}
