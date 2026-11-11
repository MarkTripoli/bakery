# Trusted artifact imports

Artifact imports read from an operator-approved bare Git repository. The HTTP
caller identifies a repository object and a repository-relative path; the caller
never supplies a local filesystem path.

## Operator mapping

Provide a versioned JSON document to the server launcher as
`BAKERY_TRUSTED_REPOSITORIES_JSON` through the deployment secret/configuration
mechanism. The document has this shape:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "organizationId": "<organization UUID>",
      "applicationId": "<application UUID>",
      "repositoryUuid": "<repository UUID>",
      "bareRepositoryPath": "/srv/bakery/trusted-repositories/<repository UUID>.git",
      "mappingRevision": "2026-09-27-1",
      "mappingDigest": "<sha256 of canonical mapping material>",
      "snapshotSha": "<lowercase 40- or 64-character Git object ID>",
      "status": "active"
    }
  ]
}
```

`mappingDigest` is the lowercase hexadecimal SHA-256 digest of the canonical
JSON for the mapping material below. Do not include `mappingDigest` itself in
the material being hashed, and do not add fields or change their names:

```json
{
  "applicationId": "<application UUID>",
  "bareRepositoryPath": "/srv/bakery/trusted-repositories/<repository UUID>.git",
  "mappingRevision": "2026-09-27-1",
  "organizationId": "<organization UUID>",
  "repositoryUuid": "<repository UUID>",
  "snapshotSha": "<40- or 64-character Git object ID>",
  "status": "active"
}
```

Use the repository, organization, and application UUIDs from the same database
scope. `snapshotSha` pins imports to one commit. Change the snapshot and
`mappingRevision`, then recompute `mappingDigest`, when promoting a new trusted
snapshot. Use `status: "revoked"` to disable an entry; remove or revoke stale
entries rather than pointing them at a new repository without a new digest.

The mapping is trusted operator configuration. It is not request data, must be
reviewed as a deployment change, and must not be constructed from an HTTP
caller-supplied path.

## Bare-repository mount

Mount each trusted repository at the exact absolute path recorded in the
mapping. The server needs a bare repository, not a caller checkout:

```text
/srv/bakery/trusted-repositories/<repository UUID>.git  (read-only)
```

The mount must be present before the server starts. Use a dedicated service
account with read-only access to the repository directory and its parent mount;
that account must not own or write the repository, hooks, objects, refs, or
mapping secret. Keep unrelated repositories and application data outside its
readable paths. Prefer a read-only bind mount or an equivalent immutable volume.

Git execution is least privilege: expose only the Git executable and the trusted
bare repository to the server process, disable terminal prompts, and do not
grant credentials, push access, repository administration, or general shell
access to the service account. The import reader validates the commit, tree
entry mode, blob type, blob size, and blob hash before writing application
facts.

Proof reads are bounded independently: a Git commit object may be at most 1 MiB
(including message and signatures), each traversed tree at most 10 MiB, and the
selected blob at most 10 MiB. Larger objects are rejected before an artifact
version or associated audit, event, outbox, or idempotency fact is written. Keep
promoted snapshots within these limits.

The importer invokes only `/usr/bin/git`; `run-main.sh` grants execution of that
absolute binary, not a PATH-resolved `git`. The child has a fixed system PATH
with system/global Git configuration and replacement-object refs disabled. Keep
the launcher's inherited PATH free of writable directories so its own startup
tools cannot be substituted.

Git proof disables lazy object fetching and Git transport protocols. Keep the
pinned commit, every traversed tree, and the selected blob locally available: a
partial/promisor repository with a missing object fails closed instead of
fetching from its configured remote. Each server process runs at most four
proofs concurrently; excess import requests receive retryable
`503 DEPENDENCY_UNAVAILABLE`.

The default `infra/compose.yaml` server starts Deno directly and does not grant
Git subprocess execution; its base image is not a verified import runtime.
Enable trusted imports only on a server with executable `/usr/bin/git` that
starts through `apps/server/scripts/run-main.sh`, then verify an authenticated
import against a read-only bare-repository mount.

## Caller request

The caller sends only a repository-relative path and the pinned commit object
ID:

```http
POST /v1/artifacts/<artifact UUID>/versions/import
Bakery-Organization-Id: <organization UUID>
Idempotency-Key: <unique key>
If-Match: "v1"
Content-Type: application/json

{
  "path": "src/readme.txt",
  "commitSha": "<snapshotSha>"
}
```

The caller's 40- or 64-character hexadecimal `commitSha` may use either case.
The importer compares its lowercase form with the trusted pinned snapshot and
stores lowercase provenance. Changing only the casing still changes the
idempotency request body; use the identical body when replaying a key.

The server resolves the organization, application, and repository scope from the
artifact graph, looks up the matching active operator entry, and verifies its
digest before invoking Git. A path beginning outside the repository, a symlink,
gitlink, directory, non-regular mode, oversized blob, or commit other than
`snapshotSha` is rejected. A missing, revoked, or digest-invalid mapping fails
closed; it does not fall back to a caller local path or a provider checkout.
The final import transaction locks the active application before its task and
artifact, then rechecks repository and caller authority before writing. An
application archival that wins that lock prevents the import from creating a
version, outbox event, audit entry, or idempotency receipt.

Strong `If-Match` and the idempotency key protect the artifact parent and replay
stored successful responses. Replays do not reread Git or create another
version, event, outbox row, audit row, or idempotency fact.

For this import action, reusing a key with a changed `If-Match` or body returns
nonretryable `422 IDEMPOTENCY_PAYLOAD_MISMATCH`; do not retry that changed
request under the same key. A concurrent use of the same key returns retryable
`409 IDEMPOTENCY_IN_FLIGHT` and may be retried after the in-flight request ends.

An HTTP `504 DEPENDENCY_TIMEOUT` from `artifactVersions.import` has an
indeterminate transaction-commit outcome; operators and callers must not infer
rollback or no write. While the idempotency receipt retention window remains
live, the same principal in the same organization may retry the identical
request with the same `Idempotency-Key`, strong `If-Match`, and body; that retry
returns the retained successful response or retryable
`409 IDEMPOTENCY_IN_FLIGHT` while the original transaction remains in flight,
after which the caller must wait for the in-flight request to finish and retry
the identical request again. A changed `If-Match` or body under the same key
remains nonretryable `422 IDEMPOTENCY_PAYLOAD_MISMATCH`. This does not promise
rollback after `504`, duplicate prevention after receipt retention expiry, a
timeout extension, a transport change, a production runner/import/action
behavior change, or an integration/security-test change.

Worker multipart publications can stream without a declared length, including
HTTP chunked transfer encoding. The server enforces the body limit while
reading, cancels over-limit streams, and rejects a publication that tries to
assert trusted `sourceRepositoryId`, `path`, or `commitSha` provenance. An
identical worker retry uses the original declared content type and metadata for
its durable request fingerprint, so a previously committed receipt still replays
after its lease expires; new stored media types are classified before the first
write.

Safe-text declarations cannot disguise active HTML or SVG in the bounded
media probe: nested active elements and event-handler attributes are rejected,
including after a leading comment or inside passive Markdown markup.
Namespace-qualified elements are conservatively rejected because a prefix can
bind to SVG or XHTML. Ordinary `<p>`, `<div>`, and `<table>` fragments remain
eligible as text; genuinely declared active media is attachment-only and cannot
be extracted.

## Authenticated retrieval and byte ranges

An authenticated caller selects an organization with `Bakery-Organization-Id`.
`GET /v1/artifacts?taskId=<task UUID>` lists authorized artifacts;
`GET /v1/artifacts/<artifact UUID>` returns metadata, and
`GET /v1/artifacts/<artifact UUID>/versions` lists version metadata. These
requests do not accept repository authority supplied by the caller.

`GET /v1/artifact-versions/<version UUID>/content` returns only bytes from the
authorized version stored in Postgres. The quoted `ETag` is the SHA-256 of the
**whole** version, including for a partial response. The response is an
attachment (`Content-Disposition: attachment`), with `nosniff`, a sandbox
content policy, and `Cache-Control: no-store`; do not embed the content inline
based on a caller-provided media type.

| Request                                                                                                                  | Result                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| No range, or `If-Range` that does not match the whole-version ETag                                                       | `200`, complete bytes and `Content-Length` equal to the version size                                        |
| One satisfiable `Range: bytes=<start>-<end>` (including open-ended or suffix form) with no `If-Range` or a matching ETag | `206`, exact requested bytes, their `Content-Length`, and `Content-Range: bytes <start>-<end>/<whole size>` |
| One syntactically valid but unsatisfiable range                                                                          | `416`, empty body, `Content-Range: bytes */<whole size>`                                                    |
| Malformed or multiple ranges                                                                                             | `400 MALFORMED_REQUEST`; the service does not assemble multipart ranges or silently fetch another object    |
| Matching authorized `If-None-Match` (strong or weak whole-version ETag, ETag list, or `*`)                               | `304`, empty body; no artifact bytes are returned even when a range was also sent                           |

A `304` has no body even when its `Content-Length` header describes the size of
the whole representation; clients must not treat that header as bytes received.

The client must compare the downloaded whole-version bytes with the advertised
SHA-256 before treating them as verified. The protected page
`/tasks/<task UUID>/artifacts/<artifact UUID>` displays authorized metadata and
provenance, offers attachment download, and keeps organization-scope changes
from exposing a previous tenant's artifact bytes. If scope selection opens
`/organizations`, the picker preserves the pending artifact deep link until an
organization is chosen. A transient organization-resolution error stays on that
deep link, offers an explicit retry, and performs no artifact reads until the
organization scope is verified.
Authentication failures during organization resolution (`AUTH_REQUIRED`,
`AUTH_EXPIRED`, or `AUTH_FACTOR_REQUIRED`) offer the existing sign-in,
authenticator, or recovery-code action while retaining that same deep link.
They do not read artifact metadata, provenance, versions, or bytes.

## Bounded text extraction

`GET /v1/artifact-versions/<version UUID>/extract?startByte=0&maxBytes=65536`
accepts byte offsets, not character indices. Extraction is restricted to
authorized, validated safe text; unsafe or active media remains download-only.
`maxBytes` must be between 1 and 65,536; `startByte` must land on a UTF-8
code-point boundary. The response includes the whole-version `sha256`,
`mediaType`, `startByte`, `endByteExclusive`, `text`, and `hasMore`. Use
`endByteExclusive` as the next start offset when `hasMore` is true. Malformed
UTF-8, noncanonical offsets, out-of-bounds windows, and unsafe media are
rejected rather than replaced with text.

A valid `maxBytes` is a bound, not a guarantee that the next complete UTF-8
code point fits. If the first code point at a valid `startByte` needs more
than `maxBytes` (for example, `é` with `maxBytes=1`), extraction returns
`422 UNPROCESSABLE` rather than an empty advancing window. Increase
`maxBytes` and request the same `startByte` again.
