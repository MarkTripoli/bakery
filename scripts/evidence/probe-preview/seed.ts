/**
 * Seeds the preview states the probe can earn, on one real organization.
 *
 *   deno run -A scripts/evidence/probe-preview/seed.ts
 *
 * The files are written the way the product writes them -- an entry, a version with
 * its bytes and digest, and (where an answer exists) a `blob_probes` row keyed on the
 * subject that version resolves to. The answers are inserted rather than measured
 * because a measured answer needs this host's systemd bus, and these stills are about
 * what the page does with an answer, not about whether the sandbox can build a unit:
 * that is proven on mini1 and in the integration lane.
 *
 * Idempotent: each run replaces the files it writes.
 *
 * Environment: source the stack's env file first, because the seed reads DATABASE_URL
 * and the auth environment from it.
 */
import {
  readDatabaseConfig,
  readEnvironmentSnapshot,
  readRuntimeConfig,
} from "@bakery/config";
import {
  authEnvironmentNames,
  readAuthTaskEnvironment,
} from "../../../apps/server/src/platform/auth-task-config.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { createSuperuser } from "../../../apps/server/src/modules/auth/index.ts";
import type { QueryResultRow } from "pg";
import { sha256Bytes } from "../../../apps/server/src/modules/knowledge/bytes.ts";
import { ensurePersonalFolder } from "../../../apps/server/src/modules/knowledge/storage-working-areas.ts";

const OWNER = {
  email: "evidence@example.test",
  password: "Evidence-Pass-1",
  display: "Sam Lee",
} as const;

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYkBBhgAJA0CAZ1s2sEAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

const databaseConfig = readDatabaseConfig(
  readEnvironmentSnapshot(["DATABASE_URL"]),
  "owner",
);
const authConfig = readRuntimeConfig(
  readAuthTaskEnvironment(
    readEnvironmentSnapshot(authEnvironmentNames),
    databaseConfig,
  ),
  "server",
).auth!;
const pg = openPgDatabase(databaseConfig.url);

async function q<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await pg.query<T>(sql, values)).rows;
}

/** What an answer said about one revision, as the runner would have written it. */
type Answer = {
  status: "described" | "refused";
  kind?: string;
  lineCount?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  code?: string;
  limit?: number;
};

async function writeAnswer(
  entryId: string,
  revision: number,
  bytes: Uint8Array,
  answer: Answer,
): Promise<void> {
  const mediaType = (await q<{ media_type: string }>(
    `select media_type from bakery.storage_file_versions
      where entry_id = $1 and revision = $2`,
    [entryId, revision],
  ))[0]!.media_type;
  await q(
    `delete from bakery.blob_probes where entry_id = $1 and revision = $2`,
    [entryId, revision],
  );
  if (answer.status === "described") {
    await q(
      `insert into bakery.blob_probes
         (organization_id, entry_id, revision, status, kind, media_type,
          byte_length, width, height, duration_ms, line_count, failure_code,
          failure_limit, probed_at)
       values ((select organization_id from bakery.storage_entries where id = $1),
               $1, $2, 'described', $3, $4, $5, $6, $7, $8, $9, null, null,
               now())`,
      [
        entryId,
        revision,
        answer.kind ?? null,
        mediaType,
        bytes.byteLength,
        answer.width ?? null,
        answer.height ?? null,
        // A video's length is the measurement its facts line states; the working
        // area's answer has to carry it, not only the artifact page's.
        answer.durationMs ?? null,
        answer.lineCount ?? null,
      ],
    );
    return;
  }
  // A refusal says which limit or fault, never a kind: nothing measured the bytes.
  await q(
    `insert into bakery.blob_probes
       (organization_id, entry_id, revision, status, kind, media_type,
        byte_length, width, height, line_count, failure_code,
        failure_limit, probed_at)
     values ((select organization_id from bakery.storage_entries where id = $1),
             $1, $2, 'refused', null, null, null, null, null, null, $3, $4, now())`,
    [entryId, revision, answer.code ?? null, answer.limit ?? null],
  );
}

/** One file with its bytes, its digest, and optionally the answer about them. */
async function writeFile(input: {
  organizationId: string;
  principalId: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  /** The current answer, about the last revision written. */
  answer?: Answer;
  /**
   * An earlier revision with its own answer, for the "older version" state: the
   * page must show that version's facts, not the current version's.
   */
  previous?: { bytes: Uint8Array; answer: Answer };
  /** A digest that is deliberately not the digest of the bytes, to seed a mismatch. */
  recordedSha256?: string;
}) {
  // The organization's own working folder, which the files page already lists as
  // "shared (shared)". A folder this seed invented would be a folder the page
  // cannot open, and a still of "This folder was not found" proves nothing.
  const folder = await q<{ id: string }>(
    `select id from bakery.storage_entries
      where organization_id = $1 and kind = 'folder' and policy = 'working'
        and parent_id is null
      order by (name_key like 'shared%') desc, created_at
      limit 1`,
    [input.organizationId],
  );
  if (folder.length === 0) throw new Error("no working folder to seed into");
  const parentId = folder[0]!.id;
  // The previous run's file is replaced, not duplicated: the unique index is
  // NULLS NOT DISTINCT and Postgres has no ON CONFLICT spelling for that, so the
  // old entry and its versions go first.
  for (
    const table of [
      "blob_probes",
      "storage_file_versions",
    ] as const
  ) {
    await q(
      `delete from bakery.${table}
        where organization_id = $1 and entry_id in
          (select id from bakery.storage_entries
            where organization_id = $1
              and parent_id is not distinct from $2::uuid
              and name_key = $3::text)`,
      [input.organizationId, parentId, input.name],
    );
  }
  await q(
    `delete from bakery.storage_entries
      where organization_id = $1 and parent_id is not distinct from $2::uuid
        and name_key = $3::text`,
    [input.organizationId, parentId, input.name],
  );
  const entry = await q<{ id: string }>(
    `insert into bakery.storage_entries
       (organization_id, parent_id, name, name_key, kind, policy, scope_key)
     values ($1, $2, $3, $3, 'file', 'working', '')
     returning id`,
    [input.organizationId, parentId, input.name],
  );
  const entryId = entry[0]!.id;

  const writeRevision = async (
    revision: number,
    bytes: Uint8Array,
    recordedSha256?: string,
  ): Promise<string> => {
    const row = await q<{ id: string }>(
      `insert into bakery.storage_file_versions
         (organization_id, entry_id, revision, content, sha256, size_bytes,
          media_type, author_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        input.organizationId,
        entryId,
        revision,
        bytes,
        recordedSha256 ?? await sha256Bytes(bytes),
        bytes.byteLength,
        input.mediaType,
        input.principalId,
      ],
    );
    return row[0]!.id;
  };

  let currentVersionId: string;
  if (input.previous === undefined) {
    currentVersionId = await writeRevision(
      1,
      input.bytes,
      input.recordedSha256,
    );
    if (input.answer !== undefined) {
      await writeAnswer(entryId, 1, input.bytes, input.answer);
    }
  } else {
    await writeRevision(1, input.previous.bytes);
    await writeAnswer(entryId, 1, input.previous.bytes, input.previous.answer);
    currentVersionId = await writeRevision(2, input.bytes);
    if (input.answer !== undefined) {
      await writeAnswer(entryId, 2, input.bytes, input.answer);
    }
  }
  await q(
    `update bakery.storage_entries set current_version_id = $2
      where organization_id = $1 and id = $3`,
    [input.organizationId, currentVersionId, entryId],
  );
  // The page selects a file by id; the path is what a person calls it.
  const folderName = (
    await q<{ name: string }>(
      `select name from bakery.storage_entries where id = $1`,
      [parentId],
    )
  )[0]!.name;
  return {
    id: entryId,
    path: `/${folderName}/${input.name}`,
    name: input.name,
    versionId: currentVersionId,
  };
}

/**
 * One application, conversation, completed task and run, with one step.
 *
 * The artifact page and the task pane both hang off a task; the pane only shows a
 * version one of this run's steps published, so the step is not decoration.
 */
async function writeTarget(organizationId: string, createdBy: string) {
  const existing = await q<{ id: string }>(
    `select id from bakery.applications
      where organization_id = $1 and slug = 'evidence'`,
    [organizationId],
  );
  const applicationId = existing[0]?.id ?? (await q<{ id: string }>(
    `insert into bakery.applications (organization_id, slug, name, description)
     values ($1, 'evidence', 'Evidence', 'Seeded for visual evidence')
     returning id`,
    [organizationId],
  ))[0]!.id;
  const conversationId = (await q<{ id: string }>(
    `insert into bakery.conversations
       (organization_id, application_id, title, created_by)
     values ($1, $2, 'Preview a recording', $3) returning id`,
    [organizationId, applicationId, createdBy],
  ))[0]!.id;
  const taskId = (await q<{ id: string }>(
    `insert into bakery.tasks
       (organization_id, application_id, conversation_id, title, description,
        task_type, status, priority, created_by, planning_only)
     values ($1, $2, $3, 'Preview a recording', 'Seeded task',
             'feature', 'completed', 0, $4, false) returning id`,
    [organizationId, applicationId, conversationId, createdBy],
  ))[0]!.id;
  // The run read refuses a run whose owner it cannot name, so the workflow and
  // its version are part of the seed rather than an afterthought.
  const workflowId = (await q<{ id: string }>(
    `select id from bakery.workflow_definitions
      where organization_id = $1 and slug = 'evidence-preview'`,
    [organizationId],
  ))[0]?.id ?? (await q<{ id: string }>(
    `insert into bakery.workflow_definitions
       (organization_id, slug, name, description)
     values ($1, 'evidence-preview', 'Evidence preview', 'Seeded workflow')
     returning id`,
    [organizationId],
  ))[0]!.id;
  const workflowVersionId = (await q<{ id: string }>(
    `select id from bakery.workflow_versions
      where organization_id = $1 and workflow_id = $2 and revision = 1`,
    [organizationId, workflowId],
  ))[0]?.id ?? (await q<{ id: string }>(
    `insert into bakery.workflow_versions
       (organization_id, workflow_id, revision, source_yaml, normalized_spec,
        digest, status, created_by)
     values ($1, $2, 1, 'steps: []', '{}'::jsonb, $3, 'published', $4)
     returning id`,
    [organizationId, workflowId, "0".repeat(64), createdBy],
  ))[0]!.id;
  const runId = (await q<{ id: string }>(
    `insert into bakery.workflow_runs
       (organization_id, task_id, workflow_version_id, requested_by, status,
        snapshot, budget_limit_usd, engine_owner_generation, kind)
     values ($1, $2, $3, $4, 'completed', '{}'::jsonb, 0, 0, 'workflow')
     returning id`,
    [organizationId, taskId, workflowVersionId, createdBy],
  ))[0]!.id;
  const stepId = (await q<{ id: string }>(
    `insert into bakery.run_steps
       (organization_id, run_id, step_key, position, iteration, status, input)
     values ($1, $2, 'publish', 0, 0, 'completed', '{}'::jsonb) returning id`,
    [organizationId, runId],
  ))[0]!.id;
  await q(
    `update bakery.tasks set current_run_id = $2
      where organization_id = $1 and id = $3`,
    [organizationId, runId, taskId],
  );
  return { taskId, runId, stepId };
}

/** One artifact version, inline bytes, optionally owned by a run step. */
async function writeArtifact(input: {
  organizationId: string;
  taskId: string;
  runStepId: string | null;
  principalId: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  answer?: Answer;
  /** A digest that is not the digest of the bytes, to seed the mismatch Banner. */
  recordedSha256?: string;
}) {
  const artifactId = (await q<{ id: string }>(
    `insert into bakery.artifacts
       (organization_id, task_id, artifact_type, name, revision, version)
     values ($1, $2, 'other', $3, 1, 1) returning id`,
    [input.organizationId, input.taskId, input.name],
  ))[0]!.id;
  const versionId = (await q<{ id: string }>(
    `insert into bakery.artifact_versions
       (organization_id, artifact_id, task_id, run_step_id, revision, author_id,
        subject_head_sha, subject_base_sha, step_key, metadata, content, sha256,
        size_bytes, media_type)
     values ($1, $2, $3, $4, 1, $5, null, null, null, '{}'::jsonb, $6, $7, $8, $9)
     returning id`,
    [
      input.organizationId,
      artifactId,
      input.taskId,
      input.runStepId,
      input.principalId,
      input.bytes,
      input.recordedSha256 ?? await sha256Bytes(input.bytes),
      input.bytes.byteLength,
      input.mediaType,
    ],
  ))[0]!.id;
  await q(
    `update bakery.artifacts set current_version_id = $2
      where organization_id = $1 and id = $3`,
    [input.organizationId, versionId, artifactId],
  );
  if (input.answer !== undefined && input.answer.status === "refused") {
    // A refusal says which fault, and never a kind: nothing measured the bytes.
    await q(
      `insert into bakery.blob_probes
         (organization_id, artifact_version_id, status, failure_code,
          failure_limit, probed_at)
       values ($1, $2, 'refused', $3, $4, now())`,
      [
        input.organizationId,
        versionId,
        input.answer.code ?? null,
        input.answer.limit ?? null,
      ],
    );
  } else if (input.answer !== undefined) {
    // A store-less version keys its answer on the version itself, which is the
    // same key `readArtifactProbe` reads.
    await q(
      `insert into bakery.blob_probes
         (organization_id, artifact_version_id, status, kind, media_type,
          byte_length, width, height, duration_ms, line_count, probed_at)
       values ($1, $2, 'described', $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        input.organizationId,
        versionId,
        input.answer.kind ?? null,
        input.mediaType,
        input.bytes.byteLength,
        input.answer.width ?? null,
        input.answer.height ?? null,
        input.answer.durationMs ?? null,
        input.answer.lineCount ?? null,
      ],
    );
  }
  return { artifactId, versionId };
}

try {
  const existing = await q<{ id: string }>(
    `select id from bakery.principals where display_name = $1 limit 1`,
    [OWNER.display],
  );
  if (existing.length === 0) {
    await createSuperuser({ pgDatabase: pg, config: authConfig }, {
      email: OWNER.email,
      displayName: OWNER.display,
      password: OWNER.password,
    });
  }
  const owner = (
    await q<{ principalId: string; organizationId: string }>(
      `select m.principal_id as "principalId", m.organization_id as "organizationId"
         from bakery.organization_memberships m
         join bakery.principals p on p.id = m.principal_id
        where p.display_name = $1 limit 1`,
      [OWNER.display],
    )
  )[0]!;
  const lines = Array.from(
    { length: 42 },
    (_, index) => `line ${index + 1} of a file whose bytes nobody opened`,
  ).join("\n");
  const shortLines = Array.from(
    { length: 12 },
    (_, index) => `line ${index + 1} of the first version`,
  ).join("\n");

  // A fresh database has the tables and no folders: the tree is made on first use
  // by the server. Bake it here, with the server's own function, so a seeded file
  // lands in the folder the page opens rather than in a folder this script invented.
  const folders = await pg.connect();
  try {
    await ensurePersonalFolder(
      folders as unknown as Parameters<typeof ensurePersonalFolder>[0],
      owner.organizationId,
      owner.principalId,
    );
  } finally {
    folders.release();
  }

  const files: Record<string, { id: string; path: string; name: string }> = {};
  // The two-second clip is used by the artifact page and by the Files panel.
  const clip = await Deno.readFile(
    new URL("./evidence-clip.mp4", import.meta.url),
  );
  // 1. A text file the sandbox read: the facts line has something to say, and the
  //    preview is cut under a fade so Download stays above the fold.
  files.text = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "release-notes.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(lines),
    answer: { status: "described", kind: "text", lineCount: 42 },
  });
  // 2. An image the sandbox measured: the kind comes from the probe, not the name.
  files.image = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "pixel.png",
    mediaType: "image/png",
    bytes: PNG,
    answer: { status: "described", kind: "image", width: 2, height: 2 },
  });
  // 3. A refusal that is about the file, so the panel says so instead of blaming
  //    the host -- and offers nothing to try again.
  files.refused = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "scan.dat",
    mediaType: "application/octet-stream",
    bytes: new TextEncoder().encode("not bytes anything can read"),
    answer: { status: "refused", code: "unreadable" },
  });
  // 4. A refusal that is about the host: no sandbox could be built, which is the
  //    one state that earns "Try again".
  files.hostUnavailable = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "stalled.bin",
    mediaType: "application/octet-stream",
    bytes: new TextEncoder().encode("bytes nobody could look at"),
    answer: { status: "refused", code: "sandbox-unavailable" },
  });
  // 5. A file over the probe's own limit, so the refusal is a limit and the copy
  //    must name the file's size and the limit as two different numbers.
  files.tooLarge = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "huge.log",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("x".repeat(64)),
    answer: { status: "refused", code: "too-large", limit: 32 },
  });
  // 6. A file whose recorded digest is not the digest of its bytes: the panel
  //    must show the Banner, say nothing else, and offer no Download.
  files.mismatch = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "corrupt.png",
    mediaType: "image/png",
    bytes: PNG,
    recordedSha256: "0".repeat(64),
    answer: { status: "described", kind: "image", width: 2, height: 2 },
  });
  // 6b. A video in the Files panel, so the panel's player and its facts line are
  //     what a still shows -- and the same video damaged, so the panel is measured
  //     on naming the file rather than blaming the browser.
  files.video = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "walkthrough.mp4",
    mediaType: "video/mp4",
    bytes: clip,
    answer: { status: "described", kind: "video", durationMs: 2_000 },
  });
  files.videoMismatch = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "walkthrough-cut.mp4",
    mediaType: "video/mp4",
    bytes: clip,
    recordedSha256: "0".repeat(64),
    answer: { status: "described", kind: "video", durationMs: 2_000 },
  });
  // 7. Two revisions with two answers: an older version selected with ?version=
  //    must show its own facts line, not the current one's.
  files.history = await writeFile({
    organizationId: owner.organizationId,
    principalId: owner.principalId,
    name: "changelog.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(lines),
    previous: {
      bytes: new TextEncoder().encode(shortLines),
      answer: { status: "described", kind: "text", lineCount: 12 },
    },
    answer: { status: "described", kind: "text", lineCount: 42 },
  });
  // The artifact page and the task pane: one task, one run, one step, and the
  // versions that hang off it. The video is a real two-second clip, so the player
  // draws a frame and the facts line has a measured length to state.
  const target = await writeTarget(owner.organizationId, owner.principalId);
  const video = await writeArtifact({
    organizationId: owner.organizationId,
    taskId: target.taskId,
    runStepId: target.stepId,
    principalId: owner.principalId,
    name: "recording.mp4",
    mediaType: "video/mp4",
    bytes: clip,
    answer: { status: "described", kind: "video", durationMs: 2_000 },
  });
  const transcript = await writeArtifact({
    organizationId: owner.organizationId,
    taskId: target.taskId,
    runStepId: target.stepId,
    principalId: owner.principalId,
    name: "transcript.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(lines),
    answer: { status: "described", kind: "text", lineCount: 42 },
  });
  // A version whose recorded digest is not the digest of its bytes: the artifact
  // page must show the Banner and offer no Download anywhere.
  const damaged = await writeArtifact({
    organizationId: owner.organizationId,
    taskId: target.taskId,
    runStepId: target.stepId,
    principalId: owner.principalId,
    name: "damaged.png",
    mediaType: "image/png",
    bytes: PNG,
    recordedSha256: "0".repeat(64),
    answer: { status: "described", kind: "image", width: 2, height: 2 },
  });
  // The task pane shows one artifact per task, so a pane still gets a task of its
  // own: the cut text under the fade, and a file nothing could read.
  const paneTextTarget = await writeTarget(
    owner.organizationId,
    owner.principalId,
  );
  await writeArtifact({
    organizationId: owner.organizationId,
    taskId: paneTextTarget.taskId,
    runStepId: paneTextTarget.stepId,
    principalId: owner.principalId,
    name: "release-notes.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(lines),
    answer: { status: "described", kind: "text", lineCount: 42 },
  });
  const paneUnreadableTarget = await writeTarget(
    owner.organizationId,
    owner.principalId,
  );
  await writeArtifact({
    organizationId: owner.organizationId,
    taskId: paneUnreadableTarget.taskId,
    runStepId: paneUnreadableTarget.stepId,
    principalId: owner.principalId,
    name: "scan.dat",
    mediaType: "application/octet-stream",
    bytes: new TextEncoder().encode("not bytes anything can read"),
    answer: { status: "refused", code: "unreadable" },
  });
  console.log(JSON.stringify({
    files,
    pane: {
      textTaskId: paneTextTarget.taskId,
      unreadableTaskId: paneUnreadableTarget.taskId,
    },
    task: {
      damagedArtifactId: damaged.artifactId,
      taskId: target.taskId,
      videoArtifactId: video.artifactId,
      transcriptArtifactId: transcript.artifactId,
    },
  }));
} finally {
  await closePgDatabase(pg);
}
