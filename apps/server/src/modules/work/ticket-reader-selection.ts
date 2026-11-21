import type {
  IssueRef,
  PredecessorProof,
  TicketActorRole,
  TicketIssueListPage,
  TicketIssueRead,
  TicketLabelPage,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketReadFailure,
  TicketRef,
  TicketSourceHandle,
  TicketSourceReader,
  TicketStatusRead,
} from "./ticket-source-reader.ts";

/**
 * The reader for a source's provider, chosen by the slug the source carries.
 *
 * Before this, one reader was built at wiring time and every source used it, so a
 * source on a different provider was read by GitHub's code: its key, its labels and
 * its statuses were interpreted against a provider that had never seen them. The
 * failure mode is not a crash, which is why it survived - the reads mostly answer
 * *something*, just about the wrong system.
 *
 * Two rules, both deliberate:
 *
 * - **Chosen per call, from the handle.** The handle already names the connection's
 *   provider, so this costs no lookup; a reader that cached the choice at
 *   construction could not serve a second provider at all.
 * - **Unknown provider fails closed.** A source whose provider this build has no
 *   reader for answers `unavailable`, with `provider_error` as the reason. That is
 *   what keeps a new provider's sources waiting for their reader instead of being
 *   read as if they were the old provider's.
 */
export function selectTicketSourceReader(
  readers: ReadonlyMap<string, TicketSourceReader>,
): TicketSourceReader {
  /**
   * The answer every method gives when no reader is registered for the provider.
   *
   * `unavailable` rather than an empty success: a source nothing can read is a
   * source that cannot admit, and the readiness check that consumes this names
   * `provider_unavailable`, so the person sees a named reason instead of an empty
   * ticket.
   */
  const noReader: TicketReadFailure = Object.freeze({
    kind: "unavailable",
    reason: "provider_error",
    retryAfterSeconds: null,
  });

  const readerFor = (handle: TicketSourceHandle): TicketSourceReader | null =>
    readers.get(handle.provider) ?? null;

  return {
    readIssue(
      handle: TicketSourceHandle,
      ref: TicketRef,
      signal: AbortSignal,
    ): Promise<TicketIssueRead> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readIssue(handle, ref, signal);
    },
    readLinks(
      handle: TicketSourceHandle,
      ref: TicketRef,
      signal: AbortSignal,
    ): Promise<TicketLinksRead> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readLinks(handle, ref, signal);
    },
    readPredecessorProof(
      handle: TicketSourceHandle,
      blocker: IssueRef,
      signal: AbortSignal,
    ): Promise<PredecessorProof | TicketReadFailure> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readPredecessorProof(handle, blocker, signal);
    },
    readLabelProvenance(
      handle: TicketSourceHandle,
      ref: TicketRef,
      label: string,
      signal: AbortSignal,
    ): Promise<TicketLabelProvenance> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readLabelProvenance(handle, ref, label, signal);
    },
    readActorRole(
      handle: TicketSourceHandle,
      login: string,
      signal: AbortSignal,
    ): Promise<TicketActorRole> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readActorRole(handle, login, signal);
    },
    readStatuses(
      handle: TicketSourceHandle,
      ref: TicketRef,
      signal: AbortSignal,
      issue?: Parameters<TicketSourceReader["readStatuses"]>[3],
    ): Promise<TicketStatusRead> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readStatuses(handle, ref, signal, issue);
    },
    listIssues(
      handle: TicketSourceHandle,
      request: { page: number; since: string | null },
      signal: AbortSignal,
    ): Promise<TicketIssueListPage> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.listIssues(handle, request, signal);
    },
    readLabels(
      handle: TicketSourceHandle,
      request: { page: number },
      signal: AbortSignal,
    ): Promise<TicketLabelPage> {
      const reader = readerFor(handle);
      return reader === null
        ? Promise.resolve(noReader)
        : reader.readLabels(handle, request, signal);
    },
  };
}
