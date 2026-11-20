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
          byte_length, width, height, line_count, failure_code,
          failure_limit, probed_at)
       values ((select organization_id from bakery.storage_entries where id = $1),
               $1, $2, 'described', $3, $4, $5, $6, $7, $8, null, null, now())`,
      [
        entryId,
        revision,
        answer.kind ?? null,
        mediaType,
        bytes.byteLength,
        answer.width ?? null,
        answer.height ?? null,
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
        await sha256Bytes(bytes),
        bytes.byteLength,
        input.mediaType,
        input.principalId,
      ],
    );
    return row[0]!.id;
  };

  let currentVersionId: string;
  if (input.previous === undefined) {
    currentVersionId = await writeRevision(1, input.bytes);
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

  const files: Record<string, { id: string; path: string; name: string }> = {};
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
  // 6. Two revisions with two answers: an older version selected with ?version=
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
  console.log(JSON.stringify({ files }));
} finally {
  await closePgDatabase(pg);
}
