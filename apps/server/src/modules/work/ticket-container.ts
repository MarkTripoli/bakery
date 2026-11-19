import type { TicketContainer } from "@bakery/contracts/ticket-admission";

/**
 * Builds the container for a repository-shaped provider.
 *
 * GitHub names a ticket's home by `owner/name` and calls it a repository. The
 * contract stores a container so that a team, a project or a workspace fits the
 * same field, which means every place that knows it is looking at a repository
 * has to say so the same way. Keeping that one conversion here means the kind
 * string and the two names cannot drift apart between the reader, the store and
 * the legacy-row normaliser.
 */
export function repositoryContainer(
  repositoryFullName: string,
): TicketContainer {
  return {
    kind: "repository",
    externalId: repositoryFullName,
    displayName: repositoryFullName,
  };
}
