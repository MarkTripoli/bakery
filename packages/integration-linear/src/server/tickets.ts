import type {
  DriverContext,
  HealthProbe,
  ProviderRequestPort,
  ResourceDiscovery,
} from "@bakery/integration-sdk/provider";
import { MAX_RESPONSE_BYTES } from "@bakery/integration-sdk";
import type {
  TicketMutation,
  TicketsPort,
} from "@bakery/integration-sdk/provider";
import {
  COMMENT_CREATE,
  ISSUE_BY_ID,
  ISSUE_BY_NUMBER,
  ISSUE_UPDATE_STATE,
  ISSUES_IN_TEAM,
  PROJECTS,
  TEAMS,
  VIEWER,
} from "./graphql.ts";
import { type LinearWorkflowState, statusOf } from "./status.ts";

/**
 * Linear's ticket port (chapter 09 section 12.3).
 *
 * The engine asks in its own words: `present` answers whether a resource is a
 * ticket and what it looks like, `mutate` applies one of the two writes the engine
 * makes. Nothing here decides anything the engine should decide - no status
 * vocabulary, no "is this work" judgement - and nothing here writes a row, because
 * the host owns the audit record.
 */

/** The GraphQL path Linear serves; the origin comes from the installation. */
export const LINEAR_GRAPHQL_PATH = "/graphql";

/**
 * Raised when Linear answers with GraphQL `errors`.
 *
 * A GraphQL server answers 200 with an `errors` array for a rejected query, so
 * status alone is not the failure signal. Throwing rather than returning a value
 * because a rejected query is a provider defect (a bad document) or an
 * authorization failure, and both must stop the call rather than be folded into
 * "no such ticket", which a caller would read as the ticket having been deleted.
 */
export class LinearGraphqlError extends Error {
  readonly errors: readonly { message: string }[];
  constructor(errors: readonly { message: string }[]) {
    super(
      `Linear rejected the query: ${
        errors.map((error) => error.message).join("; ")
      }`,
    );
    this.name = "LinearGraphqlError";
    this.errors = errors;
  }
}

type GraphqlResponse = {
  data?: unknown;
  errors?: { message: string }[];
};

/**
 * One GraphQL call.
 *
 * The body is encoded here because the host takes bytes, and the response is
 * decoded here because its shape is Linear's. `maxResponseBytes` is the SDK's
 * ceiling rather than a provider-invented one: the host enforces it, and a
 * provider that asked for more would be asking the host to trust it.
 */
async function graphql(
  provider: ProviderRequestPort,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const body = new TextEncoder().encode(JSON.stringify({ query, variables }));
  const response = await provider.send({
    method: "POST",
    path: LINEAR_GRAPHQL_PATH,
    headers: { "content-type": "application/json" },
    body,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  const text = new TextDecoder().decode(response.body);
  let parsed: GraphqlResponse;
  try {
    parsed = JSON.parse(text) as GraphqlResponse;
  } catch {
    // A non-JSON body means something other than GraphQL answered - a proxy, a
    // login page - and reporting it as "Linear said nothing" would hide that.
    throw new LinearGraphqlError([{
      message:
        `Linear answered ${response.status} with a body that is not JSON.`,
    }]);
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new LinearGraphqlError(parsed.errors);
  }
  if (parsed.data === undefined || parsed.data === null) {
    throw new LinearGraphqlError([{
      message: "Linear answered without data.",
    }]);
  }
  return parsed.data as Record<string, unknown>;
}

/** An issue as the documents above return it. */
type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  state: LinearWorkflowState | null;
  team: { id: string; name: string; key: string } | null;
};

const issueFieldsPresent = (value: unknown): value is IssueNode => {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<IssueNode>;
  return typeof node.id === "string" && typeof node.identifier === "string" &&
    typeof node.title === "string" && typeof node.url === "string" &&
    typeof node.updatedAt === "string";
};

/**
 * `ENG-42` split into a team key and a number.
 *
 * Linear team keys are uppercase letters and digits; the identifier is the key, a
 * hyphen and the team-local number. A bare number cannot be resolved without a
 * team, so it is not accepted here rather than guessed at.
 */
export function parseIdentifier(
  identifier: string,
): { teamKey: string; number: number } | null {
  const match = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/.exec(identifier);
  if (!match) return null;
  return { teamKey: match[1], number: Number(match[2]) };
}

/**
 * The stored `resourceExternalId` is Linear's issue id.
 *
 * The engine passes back what `present` returned, so a caller that quotes `ENG-42`
 * is normally already holding the id. `parseIdentifier` exists for the case where
 * a person typed the identifier, and both forms resolve to the same node.
 */
async function resolveIssue(
  ctx: DriverContext,
  resourceExternalId: string,
): Promise<IssueNode | null> {
  const byId = await graphql(ctx.provider, ISSUE_BY_ID, {
    id: resourceExternalId,
  });
  if (issueFieldsPresent(byId.issue)) return byId.issue;
  const parsed = parseIdentifier(resourceExternalId);
  if (!parsed) return null;
  const byNumber = await graphql(ctx.provider, ISSUE_BY_NUMBER, parsed);
  const nodes = (byNumber.issues as { nodes?: unknown[] } | undefined)?.nodes;
  const first = Array.isArray(nodes) ? nodes[0] : undefined;
  return issueFieldsPresent(first) ? first : null;
}

/**
 * The ticket port.
 *
 * `present` refuses rather than throws for the two ordinary outcomes - the resource
 * is not a ticket, and the ticket is closed and archived - because the engine asks
 * about every resource it sees and a pull request is not an error.
 */
export const linearTickets: TicketsPort = {
  async present(input) {
    const issue = await resolveIssue(input.ctx, input.resourceExternalId);
    if (issue === null) {
      // A resource that does not resolve to an issue is not a ticket. The engine
      // distinguishes "no such thing" from "wrong kind" by the refusal reason, and
      // a missing identifier is the honest answer for both here: Linear gave us a
      // resource we cannot read, which is not evidence about its kind.
      return { kind: "refused", reason: "missing_identifier" };
    }
    if (issue.state === null) {
      // A state is a workflow column, and a team that has not configured one leaves
      // the issue without a status. The engine groups by status, so an issue with
      // none would render as an unlabelled column.
      return { kind: "refused", reason: "wrong_container" };
    }
    const status = statusOf(issue.state);
    if (status === undefined) {
      // An undocumented state type: refuse instead of inventing a rank. This is the
      // one outcome that is a provider defect rather than a fact about the ticket,
      // and it must not be reported as a normal refusal - but it cannot throw
      // either, because one strange team would break a whole scan.
      return { kind: "refused", reason: "wrong_container" };
    }
    if (issue.team === null) {
      return { kind: "refused", reason: "wrong_container" };
    }
    return {
      kind: "ticket",
      snapshot: {
        externalId: issue.id,
        externalKey: issue.identifier,
        title: issue.title,
        container: { externalId: issue.team.id, label: issue.team.name },
        status,
        url: issue.url,
        updatedAt: new Date(issue.updatedAt),
        // Linear's documents above do not ask for actors: the engine needs them
        // only to attribute a change, and a scan that asked for every assignee and
        // creator on every page would pay for a field no page of the Issues list
        // renders. An empty list is the honest answer to "what did this document
        // read", and the refresh path is where attribution arrives.
        externalActorIds: [],
      },
      presentation: {
        title: issue.title,
        statusLabel: status.label,
        containerLabel: issue.team.name,
        url: issue.url,
        summary: `${issue.identifier} in ${issue.team.name}`,
      },
    };
  },

  async mutate(input) {
    const issue = await resolveIssue(input.ctx, input.resourceExternalId);
    if (issue === null) {
      return { ok: false, reason: "The issue no longer exists in Linear." };
    }
    const mutation: TicketMutation = input.mutation;
    if (mutation.kind === "comment") {
      const data = await graphql(input.ctx.provider, COMMENT_CREATE, {
        input: { issueId: issue.id, body: mutation.body },
      });
      const created = data.commentCreate as { success?: boolean } | undefined;
      return created?.success === true
        ? { ok: true }
        : { ok: false, reason: "Linear did not create the comment." };
    }
    const data = await graphql(input.ctx.provider, ISSUE_UPDATE_STATE, {
      id: issue.id,
      stateId: mutation.statusId,
    });
    const updated = data.issueUpdate as { success?: boolean } | undefined;
    return updated?.success === true
      ? { ok: true }
      : { ok: false, reason: "Linear did not move the issue." };
  },
};

/**
 * Discovery over the two declared kinds.
 *
 * Both are paged by Linear's own cursor, which is opaque: passing it back
 * unchanged is the whole contract, and a provider that decoded it would break on
 * Linear's next cursor format.
 */
export const linearDiscovery: ResourceDiscovery = {
  async list(input) {
    const after = input.cursor ?? null;
    const query = input.resourceKindId === "issue"
      ? ISSUES_IN_TEAM
      : input.resourceKindId === "project"
      ? PROJECTS
      : null;
    if (query === null) {
      // The host rejects an undeclared kind before calling, so reaching this means
      // the manifest and this function disagree: return an empty page rather than
      // a throw, because a scan of the other kinds is still valid work.
      return { resources: [], nextCursor: null };
    }
    if (input.resourceKindId === "issue") {
      // Issues are listed per team; a scan without a team has no page to read, so
      // the caller must name one. The host's own discovery pass always does.
      if (!input.parentExternalId) return { resources: [], nextCursor: null };
      const data = await graphql(input.ctx.provider, ISSUES_IN_TEAM, {
        teamId: input.parentExternalId,
        first: 50,
        after,
      });
      const issues = data.team as {
        issues?: { nodes?: unknown[]; pageInfo?: PageInfo };
      } | undefined;
      return page(issues?.issues, input.parentExternalId, "issue");
    }
    const data = await graphql(input.ctx.provider, PROJECTS, {
      first: 50,
      after,
    });
    return page(
      data.projects as { nodes?: unknown[]; pageInfo?: PageInfo } | undefined,
      undefined,
      "project",
    );
  },
};

type PageInfo = { hasNextPage?: boolean; endCursor?: string | null };

function page(
  connection: { nodes?: unknown[]; pageInfo?: PageInfo } | undefined,
  parentExternalId: string | undefined,
  resourceKindId: string,
): {
  resources: readonly {
    externalId: string;
    resourceKindId: string;
    name: string;
    parentExternalId?: string;
  }[];
  nextCursor: string | null;
} {
  const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
  const resources = nodes.flatMap((node) => {
    if (typeof node !== "object" || node === null) return [];
    const { id, name, title } = node as {
      id?: unknown;
      name?: unknown;
      title?: unknown;
    };
    if (typeof id !== "string") return [];
    const label = typeof name === "string"
      ? name
      : typeof title === "string"
      ? title
      : id;
    return [{
      externalId: id,
      resourceKindId,
      name: label,
      ...(parentExternalId === undefined ? {} : { parentExternalId }),
    }];
  });
  // `hasNextPage` false means no cursor even when Linear echoes the one we sent:
  // handing back a cursor that opens no further page makes a scan loop.
  const next = connection?.pageInfo?.hasNextPage === true
    ? connection.pageInfo.endCursor ?? null
    : null;
  return { resources, nextCursor: next };
}

/** Teams, for the host to offer as the container of a ticket. */
export const listTeams = async (
  ctx: DriverContext,
  cursor: string | null,
): Promise<
  { teams: readonly { id: string; name: string }[]; nextCursor: string | null }
> => {
  const data = await graphql(ctx.provider, TEAMS, { first: 50, after: cursor });
  const paged = page(
    data.teams as { nodes?: unknown[]; pageInfo?: PageInfo } | undefined,
    undefined,
    "team",
  );
  return {
    teams: paged.resources.map((resource) => ({
      id: resource.externalId,
      name: resource.name,
    })),
    nextCursor: paged.nextCursor,
  };
};

/**
 * The health probe: one cheap query that fails when the credential or the API is
 * wrong.
 *
 * `viewer` is the smallest query Linear serves that requires a valid token, so a
 * healthy answer says the credential works rather than that the network is up.
 */
export const linearHealth: HealthProbe = {
  async check(ctx) {
    try {
      const data = await graphql(ctx.provider, VIEWER, {});
      return data.viewer ? { healthy: true } : {
        healthy: false,
        reason:
          "Linear answered without a viewer; the credential may be revoked.",
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A GraphQL rejection is a bad credential or a bad document - a person has to
      // act either way. A network failure is worth retrying, and the port's own
      // errors arrive here as ordinary exceptions.
      const retryable = !(error instanceof LinearGraphqlError);
      return { healthy: false, reason: message, retryable };
    }
  },
};
