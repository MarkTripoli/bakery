/**
 * Linear's GraphQL documents.
 *
 * Strings, not a client: the host owns the request, so a document is the only part
 * of the wire format that belongs to the provider. Keeping them here means the
 * queries can be read and diffed without reading the port implementations, and a
 * test can assert a document asks for the fields the parser reads.
 *
 * Every document asks for the fields the ports map, and nothing else. A `... on
 * Issue` fragment added "just in case" is a field the host pays for on every page
 * of a scan and never reads.
 */

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  updatedAt
  state { id name type position }
  team { id name key }
`;

/** One issue by its Linear id, or by its identifier (ENG-42). */
export const ISSUE_BY_ID = `
  query BakeryIssue($id: String!) {
    issue(id: $id) {${ISSUE_FIELDS}}
  }
`;

/**
 * One issue by team key and number.
 *
 * `identifier` is not queryable on its own in Linear's schema - the `issue(id:)`
 * argument accepts an id or a bare number, not `ENG-42` - so an identifier is
 * resolved in two steps, which `resolveIssue` does.
 */
export const ISSUE_BY_NUMBER = `
  query BakeryIssueByNumber($teamKey: String!, $number: Float!) {
    issues(
      filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }
      first: 1
    ) {
      nodes {${ISSUE_FIELDS}}
    }
  }
`;

/** Issues in a team, paged. `first`/`after` are Linear's cursor arguments. */
export const ISSUES_IN_TEAM = `
  query BakeryIssues($teamId: ID!, $first: Int!, $after: String) {
    team(id: $teamId) {
      issues(first: $first, after: $after) {
        nodes {${ISSUE_FIELDS}}
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** Teams, paged: the container a ticket lives in. */
export const TEAMS = `
  query BakeryTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes { id name key }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Projects, paged: the second declared resource kind. */
export const PROJECTS = `
  query BakeryProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      nodes { id name }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** The workspace's own identity, for `identify` and for the health probe. */
export const VIEWER = `
  query BakeryViewer {
    viewer { id name email }
    organization { id name urlKey }
  }
`;

/** Add a comment to an issue. */
export const COMMENT_CREATE = `
  mutation BakeryCommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
    }
  }
`;

/** Move an issue to a workflow state. */
export const ISSUE_UPDATE_STATE = `
  mutation BakeryIssueUpdateState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id state { id name type } }
    }
  }
`;
