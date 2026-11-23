/**
 * The files commands, spoken through the session gateway (#404).
 *
 * Why a second `FilesApi` exists at all: the commands in `files.ts` were
 * written against direct REST calls with a person's access token, and a session
 * has no such token. The operations are nevertheless the *same* operations - the
 * gateway offers the storage reads and writes a step's grant reaches - so the
 * adapter below maps one catalog operation per method and changes nothing else.
 * No command re-implements a rule; `files.ts` stays the only place that decides
 * what a ref means or how a folder is printed.
 *
 * Three truths the mapping has to keep:
 *
 * - **Name the operation the gateway offers, not a command name.** The methods
 *   below are named after the storage operations (`storageFileVersions.list`,
 *   `storageFileUses.list`), because that is what a scope is granted for. A
 *   session that holds `files.read` is offered all of them; one that holds
 *   nothing is offered none, and the command says so before it calls.
 * - **A file's current revision is asked for, not assumed.** `storageFiles.content`
 *   takes an optional `revision`; the commands pass one when the ref names a
 *   revision, and omit it for a bare path so the server answers with the version
 *   current at step admission (O46). Nothing here caches.
 * - **`get` can still check a digest.** The gateway answers with the same bytes
 *   the route would, so a recorded digest travels beside them and a mismatch
 *   surfaces as `SessionFileMismatch` instead of as a corrupt file on disk.
 */

import type { BinaryArtifactClientResponse } from "@bakery/contracts/client";
import type { FilesApi, PinResult, SearchFilter, SearchHit } from "./api.ts";
import type { SessionApi } from "./session-call.ts";
import { UsageError } from "./config.ts";

/** The catalog operations this adapter calls, by the method that calls them. */
export const SESSION_FILE_OPERATIONS = Object.freeze({
  roots: "storageRoots.list",
  entries: "storageFolderEntries.list",
  versions: "storageFileVersions.list",
  uses: "storageFileUses.list",
  byVersion: "storageFiles.byVersion",
  content: "storageFiles.content",
  search: "library.search",
});

/**
 * The one files operation a session is deliberately not offered.
 *
 * Kept beside the map so the asymmetry is stated once: a pin changes how long
 * the organization's record keeps a file, and that stays an administrator's act.
 */
export const SESSION_PIN_OPERATION = "storageFiles.pin";

/** How many pages a listing reads before it decides the cursor is broken. */
const PAGE_GUARD = 1_000;

/**
 * The one refusal a person can act on differently from a grant: the record names
 * a digest and the bytes do not match it.
 */
export class SessionFileMismatch extends Error {
  override readonly name = "SessionFileMismatch";

  constructor(readonly fileId: string) {
    super(
      `The bytes of ${fileId} do not match the digest Bakery recorded for them.`,
    );
  }
}

/** What a file's bytes come back as through the gateway's JSON transport. */
type ContentAnswer = Readonly<{
  content: string;
  mediaType?: string;
  sha256?: string | null;
  sizeBytes?: number;
}>;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    out[at] = binary.charCodeAt(at);
  }
  return out;
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  // A copy, so the bytes handed to `get` or `cat` are not the buffer this
  // hashed: some runtimes hand back a view over a shared buffer, which the
  // digest API refuses and which a later write could mutate under it.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(content),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A listing that ran past the page guard, said plainly.
 *
 * The operation and the page count, because the person reading it needs to know
 * which command stopped and how far it got; the advice is the same for every one
 * of them, and it is not "try again".
 */
export class SessionListingTruncated extends Error {
  override readonly name = "SessionListingTruncated";

  constructor(readonly operation: string, readonly pages: number) {
    super(
      `${operation} answered more than ${pages} pages, so the listing was stopped. Nothing was returned: a partial list would look complete. Narrow the command, for example by listing one folder.`,
    );
  }
}

export function createSessionFilesApi(session: SessionApi): FilesApi {
  // Asked once per instance and kept: the offer is fixed for a session's life
  // (its scopes come from the credential), and asking before every call meant a
  // listing of ten pages asked eleven times for a list that could not change.
  let offer: Promise<Set<string>> | null = null;
  const offered = (): Promise<Set<string>> =>
    offer ??= session.tools().then((tools) =>
      new Set(tools.map((tool) => tool.name))
    );
  const call = async <T>(operation: string, args: unknown): Promise<T> => {
    if (!(await offered()).has(operation)) {
      // Before calling, because the gateway's answer is "not offered" too, and
      // that reads like a fault. This says which grant is missing.
      throw new UsageError(
        `This session was not granted ${operation}, so that command cannot run here.`,
      );
    }
    return await session.call(operation, args) as T;
  };
  const allPages = async <T>(
    operation: string,
    args: Record<string, unknown> = {},
  ): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PAGE_GUARD; page += 1) {
      const answer = await call<{ items?: T[]; nextCursor?: string | null }>(
        operation,
        { ...args, ...(cursor === undefined ? {} : { cursor }) },
      );
      items.push(...(answer.items ?? []));
      const next = answer.nextCursor ?? null;
      if (next === null) return items;
      cursor = next;
    }
    // The guard is a fault, not a stopping point. Returning what came back would
    // hand the caller a listing that looks complete: an agent told "these are the
    // files" would conclude the ones past the last page do not exist.
    throw new SessionListingTruncated(operation, PAGE_GUARD);
  };
  const one = async <T>(operation: string, args: unknown): Promise<T> =>
    await call<T>(operation, args);

  return {
    roots: () => allPages(SESSION_FILE_OPERATIONS.roots),
    entries: (folderId) =>
      allPages(SESSION_FILE_OPERATIONS.entries, { id: folderId }),
    versions: (fileId) =>
      allPages(SESSION_FILE_OPERATIONS.versions, { id: fileId }),
    uses: (fileId) => allPages(SESSION_FILE_OPERATIONS.uses, { id: fileId }),
    byVersion: (versionId) =>
      one(SESSION_FILE_OPERATIONS.byVersion, { id: versionId }),
    pin: () =>
      // Pinning keeps a record file's versions past retention, and that is an
      // administrator's act on the organization's record, not an agent's: the
      // session operation map does not offer it, so the command says so before
      // making a call that could only be refused.
      Promise.reject(
        new UsageError(
          "A pin is an administrator's action, and a session is not offered it. Ask a person to pin the file.",
        ),
      ) as Promise<PinResult>,
    search: async (filter: SearchFilter) => {
      // `library.search` is one query across skills, agents and artifacts; the
      // files command's own filters (a folder, a kind, a media type) have no
      // counterpart there, so a filter that cannot be honoured is refused rather
      // than silently dropped - a search that quietly returns more than asked
      // is how an agent concludes a file exists in a folder it never looked in.
      for (const [name, value] of Object.entries(filter)) {
        if (name !== "query" && name !== "kind" && value !== undefined) {
          throw new UsageError(
            `This session cannot filter a search by ${name}: the library search it can reach takes text and a kind only.`,
          );
        }
      }
      const query = filter.query ?? "";
      if (query.trim() === "") {
        throw new UsageError(
          "In a session, search needs words: the library search takes text.",
        );
      }
      const answer = await call<{ items?: SearchHit[] }>(
        SESSION_FILE_OPERATIONS.search,
        { query, ...(filter.kind === undefined ? {} : { kind: filter.kind }) },
      );
      return answer.items ?? [];
    },
    content: async (fileId, options) => {
      const answer = await one<ContentAnswer>(
        SESSION_FILE_OPERATIONS.content,
        {
          id: fileId,
          ...(options.revision === undefined
            ? {}
            : { revision: options.revision }),
          ...(options.range === undefined ? {} : { range: options.range }),
        },
      );
      const content = decodeBase64(answer.content ?? "");
      const recorded = answer.sha256 ?? null;
      // A range is a slice, so its digest is not the file's: only a whole read
      // can be checked against the record.
      if (recorded !== null && options.range === undefined) {
        if (await sha256Hex(content) !== recorded) {
          throw new SessionFileMismatch(fileId);
        }
      }
      const response: BinaryArtifactClientResponse = {
        status: 200,
        contentType: answer.mediaType ?? "application/octet-stream",
        contentLength: content.byteLength,
        contentDigest: recorded ?? "",
        content,
        etag: recorded === null ? "" : `"${recorded}"`,
        ...(options.range === undefined ? {} : { contentRange: options.range }),
      } as BinaryArtifactClientResponse;
      return response;
    },
  };
}
