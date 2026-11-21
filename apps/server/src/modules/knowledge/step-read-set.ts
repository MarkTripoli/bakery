/**
 * The step read set and pinned inputs (chapter 25 section 17.6, O46, issue
 * #448 S6). An agent's storage read joins its step's read set in the read's
 * own transaction, and a read of a declared input is served from the version
 * the run pinned at admission (bakery.run_input_pins), so a retry sees the
 * same bytes even after a newer version lands. A read the agent names a
 * revision for, and any read of a file that is not a declared input, is the
 * latest (or named) version and is recorded as unpinned. A person's own read
 * records nothing and is never pinned.
 */

import type { ActionContext } from "@bakery/contracts/action-registry";
import type { PgTransactionClient } from "@bakery/persistence";
import { attemptOrigin } from "../auth/application/agent-power-grants.ts";
import { sha256Bytes } from "./bytes.ts";

/** The session a read came from, or null for a person's own request. */
export type StepReader = Readonly<{
  attemptId: string;
  agentSessionId: string | null;
  runId: string;
}>;

/** The run's admission pin of one artifact. */
export type InputPin = Readonly<{ artifactVersionId: string; sha256: string }>;

/** Which version a file read serves. */
export type ReadChoice =
  | Readonly<{ kind: "pinned"; artifactVersionId: string }>
  | Readonly<{ kind: "latest" }>;

/**
 * The pin rule, pure: an agent's read of a declared input with no revision
 * named is the pinned version; a named revision (the latest on request, O46)
 * and a file with no pin are read as asked.
 */
export function chooseRead(
  input: Readonly<{
    reader: StepReader | null;
    pin: InputPin | null;
    revision: number | null;
  }>,
): ReadChoice {
  if (input.reader === null || input.pin === null) return { kind: "latest" };
  if (input.revision !== null) return { kind: "latest" };
  return { kind: "pinned", artifactVersionId: input.pin.artifactVersionId };
}

export type StepReadSetRow = Readonly<{
  organizationId: string;
  attemptId: string;
  agentSessionId: string | null;
  entryId: string;
  versionId: string | null;
  artifactVersionId: string | null;
  sha256: string;
  pinned: boolean;
}>;

/**
 * The read-set row for one read, or null for a person's read. A record-area
 * file names its artifact version, a working-area file its storage version, a
 * folder listing neither.
 */
export function stepReadSetRow(
  reader: StepReader | null,
  read: Readonly<{
    organizationId: string;
    entryId: string;
    served:
      | Readonly<{ kind: "artifact"; versionId: string }>
      | Readonly<{ kind: "storage"; versionId: string }>
      | Readonly<{ kind: "listing" }>;
    sha256: string;
    pinned: boolean;
  }>,
): StepReadSetRow | null {
  if (reader === null) return null;
  return {
    organizationId: read.organizationId,
    attemptId: reader.attemptId,
    agentSessionId: reader.agentSessionId,
    entryId: read.entryId,
    versionId: read.served.kind === "storage" ? read.served.versionId : null,
    artifactVersionId: read.served.kind === "artifact"
      ? read.served.versionId
      : null,
    sha256: read.sha256,
    pinned: read.pinned,
  };
}

/**
 * The digest a folder listing is recorded under: one line per listed entry
 * (id, kind, current version), in the order the page returned them.
 */
export async function listingDigest(
  items: readonly Readonly<{
    id: string;
    kind: string;
    versionId: string | null;
  }>[],
): Promise<string> {
  const text = items.map((item) =>
    item.id + " " + item.kind + " " + (item.versionId ?? "-")
  ).join("\n");
  return await sha256Bytes(new TextEncoder().encode(text));
}

/** The session and run a call came from; null for a person or a run-less attempt. */
export async function stepReaderOf(
  tx: PgTransactionClient,
  context: Pick<ActionContext, "agentSession">,
  organizationId: string,
): Promise<StepReader | null> {
  if (context.agentSession === undefined) return null;
  const attemptId = context.agentSession.attemptId;
  const origin = await attemptOrigin(tx, organizationId, attemptId);
  if (origin === null) return null;
  return {
    attemptId,
    agentSessionId: origin.agentSessionId,
    runId: origin.runId,
  };
}

/** The run's admission pin of an artifact, if the run declared it as an input. */
export async function inputPinFor(
  tx: PgTransactionClient,
  organizationId: string,
  runId: string,
  artifactId: string,
): Promise<InputPin | null> {
  const found = await tx.query<{ artifact_version_id: string; sha256: string }>(
    "select artifact_version_id, sha256 from bakery.run_input_pins" +
      " where organization_id = $1 and run_id = $2 and artifact_id = $3" +
      " order by created_at desc, id desc limit 1",
    [organizationId, runId, artifactId],
  );
  const row = found.rows[0];
  return row
    ? { artifactVersionId: row.artifact_version_id, sha256: row.sha256 }
    : null;
}

/** Inserts one read-set row in the read's transaction. */
export async function recordStepRead(
  tx: PgTransactionClient,
  row: StepReadSetRow,
): Promise<void> {
  await tx.query(
    "insert into bakery.step_read_set" +
      " (organization_id, attempt_id, agent_session_id, entry_id," +
      " version_id, artifact_version_id, sha256, pinned)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      row.organizationId,
      row.attemptId,
      row.agentSessionId,
      row.entryId,
      row.versionId,
      row.artifactVersionId,
      row.sha256,
      row.pinned,
    ],
  );
}
