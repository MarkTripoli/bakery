import type {
  ApiFailure,
  ApiResult,
  DraftPublicationResponse,
  DraftResponse,
} from "../api/client.ts";

/** What publishing needs from the API; tests pass fakes. */
export type PublishDeps = Readonly<{
  /** Reads the draft as it stands: its current checkpoint and text digest. */
  readDraft: () => Promise<ApiResult<DraftResponse>>;
  /** Publishes one checkpoint; the same checkpoint gives the same version. */
  publish: (
    input: { checkpointId: string; textDigest: string },
  ) => Promise<ApiResult<DraftPublicationResponse>>;
  /** The publication of one checkpoint, if it happened. */
  lookup: (
    checkpointId: string,
  ) => Promise<ApiResult<DraftPublicationResponse>>;
}>;

/** What the person is told. */
export type PublishOutcome =
  | Readonly<{ kind: "published"; publication: DraftPublicationResponse }>
  /** The text moved on since the preview; nothing was published. */
  | Readonly<{ kind: "moved" }>
  /** This person may not publish, or the draft is gone. */
  | Readonly<{ kind: "forbidden" }>
  /** The answer did not arrive: it may or may not have been published. */
  | Readonly<{ kind: "unknown"; checkpointId: string }>
  /** The server refused for a reason that publishing again will not fix. */
  | Readonly<{ kind: "refused"; checkpointId: string }>;

const status = (failure: ApiFailure): number | null =>
  failure.kind === "problem" ? failure.problem.status : null;

/**
 * Publishes the checkpoint the person previewed. If the server says it moved
 * on (precondition failed) the draft is read again: when the text is still the
 * text they saw (same digest) the new checkpoint is published, once, because
 * the promise holds; when the text changed, nothing is published and the
 * person is told, so the next press publishes what they have just seen. A lost
 * answer is never retried here: the caller looks the checkpoint up.
 */
export async function publishCheckpoint(
  deps: PublishDeps,
  previewed: Readonly<{ checkpointId: string; textDigest: string }>,
): Promise<PublishOutcome> {
  // Only the contract's two fields go out; callers may hold more.
  let target = {
    checkpointId: previewed.checkpointId,
    textDigest: previewed.textDigest,
  };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await deps.publish(target);
    if (result.ok) return { kind: "published", publication: result.data };
    const code = status(result.error);
    if (code === 403 || code === 404) return { kind: "forbidden" };
    if (code === 412) {
      if (attempt === 2) return { kind: "moved" };
      const reread = await deps.readDraft();
      if (!reread.ok || reread.data.textDigest !== previewed.textDigest) {
        return { kind: "moved" };
      }
      target = {
        checkpointId: reread.data.checkpointId,
        textDigest: reread.data.textDigest,
      };
      continue;
    }
    if (code !== null && code >= 400 && code < 500) {
      return { kind: "refused", checkpointId: target.checkpointId };
    }
    // A network failure, a 5xx or an unreadable answer: it may have happened.
    return { kind: "unknown", checkpointId: target.checkpointId };
  }
  return { kind: "moved" };
}

/**
 * Looks for the publication of a checkpoint whose answer was lost. Never
 * publishes: "found" is the version, "absent" means it did not happen,
 * "unknown" means the look itself failed.
 */
export async function lookForPublication(
  deps: PublishDeps,
  checkpointId: string,
): Promise<
  | Readonly<{ kind: "found"; publication: DraftPublicationResponse }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unknown" }>
> {
  const result = await deps.lookup(checkpointId);
  if (result.ok) return { kind: "found", publication: result.data };
  if (status(result.error) === 404) return { kind: "absent" };
  return { kind: "unknown" };
}
