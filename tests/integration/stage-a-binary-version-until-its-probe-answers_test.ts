/**
 * Binary publishing is staged, then current (chapter 25 section 17.5, O29,
 * #437 final slice), against real Postgres.
 *
 * A version published under a kind with a probe-backed rule is written staged:
 * it is not the artifact's current version, and the version list shows it as
 * staged while no reader serves its bytes. The probe
 * runner, with a stub launcher standing in for the sandbox, stores the answer
 * and in the same transaction promotes the version to current or refuses it.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { readRuntimeConfig } from "@bakery/config";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { commitArtifactVersion } from "../../apps/server/src/modules/knowledge/persistence.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { forgetSandboxPreflight } from "../../apps/server/src/modules/knowledge/probe.ts";
import {
  PROBE_MAX_ATTEMPTS,
  runProbeTick,
} from "../../apps/server/src/modules/knowledge/probe-runner.ts";
import { writeBlobProbe } from "../../apps/server/src/modules/knowledge/blob-probes.ts";
import { settleStagedVersions } from "../../apps/server/src/modules/knowledge/staged-versions.ts";
import {
  extractArtifactVersion,
  readArtifactVersionIdentity,
} from "../../apps/server/src/modules/knowledge/extraction.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { probeRunnerDeps } from "../../apps/server/src/platform/probe-runner-task.ts";
import {
  READ_ONLY,
  SEALED,
  writeStub,
} from "../helpers/probe-stub-launcher.ts";

const frame = (fields: Record<string, unknown>) =>
  JSON.stringify({
    result: {
      status: "described",
      kind: "image",
      mediaType: "image/png",
      byteLength: 8,
      ...fields,
    },
  });

const IMAGE_KIND_RULES = [
  {
    type: "mediaType",
    severity: "require",
    options: { mediaTypes: ["image/png"] },
  },
  {
    type: "probedMediaType",
    severity: "require",
    options: { mediaTypes: ["image/png"] },
  },
  { type: "maxPixels", severity: "require", options: { value: 100 } },
];

/** A kind keyed `image`, so every `image` artifact in the task binds to it. */
async function publishKind(fixture: WorkerFixture, rules: unknown[]) {
  const kind = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_kinds (organization_id, key)
     values ($1, 'image') returning id`,
    [fixture.organizationId],
  );
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_kind_versions
       (organization_id, kind_id, revision, definition, digest)
     values ($1, $2, 1, $3, 'test-digest') returning id`,
    [
      fixture.organizationId,
      kind.rows[0].id,
      {
        key: "image",
        name: "Image",
        description: "A rendered still.",
        text: false,
        facts: [],
        rules,
      },
    ],
  );
  return version.rows[0].id;
}

async function seedTask(fixture: WorkerFixture) {
  const applicationId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1::uuid, $2, $1::text, 'Staged versions')`,
    [applicationId, fixture.organizationId],
  );
  const conversation = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.conversations
       (organization_id, application_id, title, created_by)
     values ($1, $2, 'staged', $3) returning id`,
    [fixture.organizationId, applicationId, fixture.principalId],
  );
  const task = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.tasks
       (organization_id, application_id, conversation_id, title, task_type,
        status, created_by)
     values ($1, $2, $3, 'staged', 'feature', 'completed', $4)
     returning id`,
    [
      fixture.organizationId,
      applicationId,
      conversation.rows[0].id,
      fixture.principalId,
    ],
  );
  return { applicationId, taskId: task.rows[0].id };
}

/** Publishes one inline version of an artifact as a person would. */
async function publish(
  fixture: WorkerFixture,
  seeded: { applicationId: string; taskId: string },
  input: { artifactType: string; name: string; bytes: Uint8Array },
) {
  const artifact = await fixture.pgDatabase.query<
    {
      id: string;
      revision: number;
      version: number;
      current_version_id: string | null;
    }
  >(
    `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
     values ($1, $2, $3, $4)
     on conflict (organization_id, task_id, artifact_type, name)
       do update set updated_at = now()
     returning id, revision, version, current_version_id`,
    [fixture.organizationId, seeded.taskId, input.artifactType, input.name],
  );
  const parent = artifact.rows[0];
  const response = await withPgTransaction(
    fixture.pgDatabase,
    async (transaction) =>
      await commitArtifactVersion(transaction, {
        scope: {
          organizationId: fixture.organizationId,
          taskId: seeded.taskId,
          applicationId: seeded.applicationId,
          repositoryId: null,
          conversationId: null,
        },
        parent: {
          id: parent.id,
          revision: parent.revision,
          version: parent.version,
          currentVersionId: parent.current_version_id,
        },
        version: {
          parentVersionId: parent.current_version_id === null
            ? null
            : `"${parent.current_version_id}"`,
          runStepId: null,
          authorId: fixture.principalId,
          subjectHeadSha: null,
          subjectBaseSha: null,
          stepKey: null,
          metadata: {},
          content: input.bytes,
          sha256: await sha256Bytes(input.bytes),
          mediaType: "image/png",
        },
        promotion: { kind: "human" },
      }),
  );
  return {
    artifactId: parent.id,
    versionId: String(response.id),
    publicationStatus: response.publicationStatus,
  };
}

async function state(
  fixture: WorkerFixture,
  artifactId: string,
  versionId: string,
) {
  const row = await fixture.pgDatabase.query<{
    publication_status: string;
    refused_kind_version_id: string | null;
    refused_rule_type: string | null;
    refused_reason: string | null;
    current_version_id: string | null;
    probes: number;
  }>(
    `select v.publication_status, v.refused_kind_version_id,
            v.refused_rule_type, v.refused_reason, a.current_version_id,
            (select count(*)::int from bakery.blob_probes p
              where p.organization_id = v.organization_id
                and p.artifact_version_id = v.id) as probes
       from bakery.artifact_versions v
       join bakery.artifacts a
         on a.organization_id = v.organization_id and a.id = v.artifact_id
      where v.organization_id = $1 and v.id = $2 and a.id = $3`,
    [fixture.organizationId, versionId, artifactId],
  );
  return row.rows[0];
}

/** The versions list the app shows, through the real route. */
async function listedVersionIds(fixture: WorkerFixture, artifactId: string) {
  const response = await fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/artifacts/${artifactId}/versions`,
      {
        headers: {
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          Cookie: fixture.adminCookie,
        },
      },
    ),
  );
  assertEquals(response.status, 200, await response.clone().text());
  const page = await response.json() as {
    items: {
      id: string;
      publicationStatus?: string;
      refusedKindVersionId?: string | null;
      refusedRuleType?: string | null;
      refusedReason?: string | null;
    }[];
  };
  return page.items;
}

/** One runner tick with a stub sandbox whose probe branch is `probe`. */
async function tick(fixture: WorkerFixture, probe: string) {
  const dir = await Deno.makeTempDir();
  const spoolDir = await Deno.makeTempDir();
  try {
    const launcher = await writeStub(dir, "sealed", {
      selfTest: SEALED,
      filesystem: READ_ONLY,
      probe,
    });
    const config = readRuntimeConfig(
      {
        BAKERY_ENV: "test",
        BAKERY_PROBE_SPOOL_DIR: spoolDir,
        BAKERY_PUBLIC_BASE_URL: fixture.config.publicBaseUrl,
      },
      "server",
    );
    const built = probeRunnerDeps(config, fixture.pgDatabase);
    forgetSandboxPreflight();
    return await runProbeTick(
      fixture.pgDatabase,
      {
        ...built,
        probeOptions: { ...built.probeOptions, launcherPath: launcher },
      },
      { limit: 25 },
    );
  } finally {
    forgetSandboxPreflight();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(spoolDir, { recursive: true });
  }
}

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("an image over maxPixels is staged, then refused, and never becomes latest", () =>
  withWorkerFixture(async (fixture) => {
    const kindVersionId = await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Too big",
      bytes: bytes("pretend png, too many pixels"),
    });
    assertEquals(published.publicationStatus, "staged");
    const staged = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(staged.publication_status, "staged");
    assertEquals(
      staged.current_version_id,
      null,
      "a staged version is not latest",
    );
    const stagedList = await listedVersionIds(fixture, published.artifactId);
    assertEquals(stagedList.map((item) => item.id), [published.versionId]);
    assertEquals(stagedList[0].publicationStatus, "staged");
    assertEquals(stagedList[0].refusedReason, null);

    const result = await tick(
      fixture,
      `printf '%s' '${frame({ width: 20, height: 20 })}'`,
    );
    assertEquals(result.answered, 1, JSON.stringify(result));

    const refused = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(refused.publication_status, "refused");
    assertEquals(refused.refused_kind_version_id, kindVersionId);
    assertEquals(refused.refused_rule_type, "maxPixels");
    assert(
      refused.refused_reason?.includes("400"),
      refused.refused_reason ?? "",
    );
    assertEquals(refused.current_version_id, null);
    assertEquals(refused.probes, 1, "the answer is stored with the verdict");
    // The list shows the refusal and why, read through the real route.
    const refusedList = await listedVersionIds(fixture, published.artifactId);
    assertEquals(refusedList.map((item) => item.id), [published.versionId]);
    assertEquals(refusedList[0].publicationStatus, "refused");
    assertEquals(refusedList[0].refusedKindVersionId, kindVersionId);
    assertEquals(refusedList[0].refusedRuleType, "maxPixels");
    assertEquals(refusedList[0].refusedReason, refused.refused_reason);
  }));

Deno.test("an image within maxPixels is staged, then current, and becomes latest", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Fits",
      bytes: bytes("pretend png, small"),
    });
    assertEquals(published.publicationStatus, "staged");

    const result = await tick(
      fixture,
      `printf '%s' '${frame({ width: 10, height: 10 })}'`,
    );
    assertEquals(result.answered, 1, JSON.stringify(result));

    const current = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(current.publication_status, "current");
    assertEquals(current.current_version_id, published.versionId);
    const listed = await listedVersionIds(fixture, published.artifactId);
    assertEquals(listed.map((item) => item.id), [published.versionId]);
    assertEquals(listed[0].publicationStatus, "current");
  }));

Deno.test("a file declared image/png that the probe finds is a gif is refused by probedMediaType", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Lies",
      bytes: bytes("GIF89a, labelled png"),
    });
    await tick(
      fixture,
      `printf '%s' '${frame({ mediaType: "image/gif", width: 1, height: 1 })}'`,
    );
    const refused = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(refused.publication_status, "refused");
    assertEquals(refused.refused_rule_type, "probedMediaType");
    assertEquals(refused.current_version_id, null);
  }));

Deno.test("a probe that refuses the file itself refuses the staged version with that reason", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Broken",
      bytes: bytes("not an image at all"),
    });
    await tick(
      fixture,
      `printf '%s' '{"result":{"status":"refused","code":"malformed"}}'`,
    );
    const refused = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(refused.publication_status, "refused");
    assertEquals(refused.refused_rule_type, null);
    assertEquals(refused.refused_reason, "malformed");
  }));

Deno.test("a host fault stores nothing and leaves the version staged", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Unlucky",
      bytes: bytes("fine bytes, bad host"),
    });
    // The launcher dies without answering: the probe reports that as a host
    // fault, which says nothing about the file.
    const result = await tick(fixture, "exit 1");
    assertEquals(result.answered, 0, JSON.stringify(result));
    assertEquals(result.deferred, 1, JSON.stringify(result));
    const still = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(still.publication_status, "staged");
    assertEquals(still.probes, 0, "a host fault is never stored");
    assertEquals(still.current_version_id, null);
    const request = await fixture.pgDatabase.query<{ attempts: number }>(
      `select attempts from bakery.probe_requests
        where organization_id = $1 and artifact_version_id = $2`,
      [fixture.organizationId, published.versionId],
    );
    assertEquals(request.rows[0]?.attempts, 1, "the request waits for a retry");

    // A healthy host on the next tick settles it.
    await tick(fixture, `printf '%s' '${frame({ width: 2, height: 2 })}'`);
    const settled = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(settled.publication_status, "current");
    assertEquals(settled.current_version_id, published.versionId);
  }));

Deno.test("another organization's answer cannot settle a staged version", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Mine",
      bytes: bytes("only my organization decides"),
    });
    const otherOrganizationId = crypto.randomUUID();
    const settled = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        settleStagedVersions(transaction, {
          organizationId: otherOrganizationId,
          subject: { artifactVersionId: published.versionId },
          result: {
            status: "described",
            kind: "image",
            mediaType: "image/png",
            byteLength: 8,
            width: 1,
            height: 1,
          },
        }),
    );
    assertEquals(settled, { promoted: 0, refused: 0 });
    const still = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(still.publication_status, "staged");
    assertEquals(still.current_version_id, null);
  }));

Deno.test("a kind without probe-backed rules publishes current at once", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, [IMAGE_KIND_RULES[0]]);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Plain",
      bytes: bytes("declared png, no probe rule"),
    });
    assertEquals(published.publicationStatus, "current");
    const current = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(current.publication_status, "current");
    assertEquals(current.current_version_id, published.versionId);
  }));

const openRequests = async (fixture: WorkerFixture, versionId: string) =>
  (await fixture.pgDatabase.query(
    `select 1 from bakery.probe_requests
      where organization_id = $1 and artifact_version_id = $2`,
    [fixture.organizationId, versionId],
  )).rows.length;

Deno.test("an answer already on record settles a staged version and clears its request", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Answered before the tick",
      bytes: bytes("pretend png, answered"),
    });
    assertEquals(published.publicationStatus, "staged");
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      artifactVersionId: published.versionId,
      result: {
        status: "described",
        kind: "image",
        mediaType: "image/png",
        byteLength: 8,
        width: 10,
        height: 10,
      },
    });
    // The stub would answer over the limit; a tick that probed again instead of
    // settling on the stored answer would refuse the version.
    const result = await tick(
      fixture,
      `printf '%s' '${frame({ width: 1000, height: 1000 })}'`,
    );
    assertEquals(result.answered, 1, JSON.stringify(result));
    const current = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(current.publication_status, "current");
    assertEquals(current.current_version_id, published.versionId);
    assertEquals(await openRequests(fixture, published.versionId), 0);
  }));

Deno.test("the runner settles under the request's row lock, so an enqueue in flight is never lost", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Locked",
      bytes: bytes("pretend png, locked"),
    });
    // A publisher's enqueue holds this row while its transaction is open; the
    // runner must wait for it rather than settle and delete around it.
    const holder = await fixture.pgDatabase.connect();
    try {
      await holder.query("begin");
      await holder.query(
        `select id from bakery.probe_requests
          where organization_id = $1 and artifact_version_id = $2 for update`,
        [fixture.organizationId, published.versionId],
      );
      const running = tick(
        fixture,
        `printf '%s' '${frame({ width: 10, height: 10 })}'`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assertEquals(
        (await state(fixture, published.artifactId, published.versionId))
          .publication_status,
        "staged",
        "the runner settled while the request row was held",
      );
      await holder.query("commit");
      const result = await running;
      assertEquals(result.answered, 1, JSON.stringify(result));
    } finally {
      holder.release();
    }
    const current = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(current.publication_status, "current");
    assertEquals(await openRequests(fixture, published.versionId), 0);
  }));

/** Reads the content route of one version as the fixture's admin. */
async function getContent(
  fixture: WorkerFixture,
  versionId: string,
  range?: string,
) {
  const headers: Record<string, string> = {
    Origin: fixture.config.publicBaseUrl,
    "Bakery-Organization-Id": fixture.organizationId,
    Cookie: fixture.adminCookie,
  };
  if (range) headers.Range = range;
  return await fixture.app.fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/artifact-versions/${versionId}/content`,
      { headers },
    ),
  );
}

Deno.test("the content route does not serve the bytes of a staged version", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Staged content",
      bytes: bytes("staged bytes that no one vetted"),
    });
    assertEquals(published.publicationStatus, "staged");
    const full = await getContent(fixture, published.versionId);
    await full.body?.cancel();
    const ranged = await getContent(fixture, published.versionId, "bytes=0-3");
    await ranged.body?.cancel();
    assert(
      full.status !== 200 && ranged.status !== 206 && ranged.status !== 200,
      `staged bytes served: full=${full.status} range=${ranged.status}`,
    );
  }));

Deno.test("the content route does not serve the bytes of a refused version", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Refused content",
      bytes: bytes("pretend png, too many pixels"),
    });
    const result = await tick(
      fixture,
      `printf '%s' '${frame({ width: 20, height: 20 })}'`,
    );
    assertEquals(result.answered, 1, JSON.stringify(result));
    const row = await state(fixture, published.artifactId, published.versionId);
    assertEquals(row.publication_status, "refused");
    const full = await getContent(fixture, published.versionId);
    await full.body?.cancel();
    assert(full.status !== 200, `refused bytes served: ${full.status}`);
  }));

Deno.test("the version list shows a staged and a refused version while content of each is not found", () =>
  withWorkerFixture(async (fixture) => {
    const kindVersionId = await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const refusedOne = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Listed",
      bytes: bytes("pretend png, too many pixels"),
    });
    await tick(fixture, `printf '%s' '${frame({ width: 20, height: 20 })}'`);
    const stagedOne = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Listed",
      bytes: bytes("pretend png, second revision"),
    });
    assertEquals(stagedOne.artifactId, refusedOne.artifactId);
    assertEquals(stagedOne.publicationStatus, "staged");
    const listed = await listedVersionIds(fixture, refusedOne.artifactId);
    const byId = new Map(listed.map((item) => [item.id, item]));
    assertEquals(byId.size, 2, JSON.stringify(listed));
    const refused = byId.get(refusedOne.versionId)!;
    assertEquals(refused.publicationStatus, "refused");
    assertEquals(refused.refusedKindVersionId, kindVersionId);
    assertEquals(refused.refusedRuleType, "maxPixels");
    assert(refused.refusedReason?.includes("400"), refused.refusedReason ?? "");
    const staged = byId.get(stagedOne.versionId)!;
    assertEquals(staged.publicationStatus, "staged");
    assertEquals(staged.refusedReason, null);
    for (const versionId of [refusedOne.versionId, stagedOne.versionId]) {
      const content = await getContent(fixture, versionId);
      await content.body?.cancel();
      assertEquals(content.status, 404, `content of ${versionId}`);
    }
  }));

Deno.test("a stored host-limit answer does not clear the request of a version staged since", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Timed out before",
      bytes: bytes("pretend png, timed out once"),
    });
    assertEquals(published.publicationStatus, "staged");
    // A timeout stored for these bytes while nothing waited on them.
    await writeBlobProbe(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      artifactVersionId: published.versionId,
      result: { status: "refused", code: "timeout" },
    });
    const result = await tick(
      fixture,
      `printf '%s' '${frame({ width: 10, height: 10 })}'`,
    );
    assertEquals(result.answered, 1, JSON.stringify(result));
    const settled = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(settled.publication_status, "current", "probed again");
    assertEquals(settled.current_version_id, published.versionId);
    assertEquals(await openRequests(fixture, published.versionId), 0);
  }));

Deno.test("a request abandoned at the attempt ceiling refuses its staged version as probe-abandoned", () =>
  withWorkerFixture(async (fixture) => {
    await publishKind(fixture, IMAGE_KIND_RULES);
    const seeded = await seedTask(fixture);
    const published = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Never answered",
      bytes: bytes("fine bytes, host never answers"),
    });
    await fixture.pgDatabase.query(
      `update bakery.probe_requests set attempts = $3
        where organization_id = $1 and artifact_version_id = $2`,
      [fixture.organizationId, published.versionId, PROBE_MAX_ATTEMPTS - 1],
    );
    const result = await tick(fixture, "exit 1");
    assertEquals(result.abandoned, 1, JSON.stringify(result));
    const refused = await state(
      fixture,
      published.artifactId,
      published.versionId,
    );
    assertEquals(refused.publication_status, "refused");
    assertEquals(refused.refused_reason, "probe-abandoned");
    assertEquals(refused.refused_rule_type, null);
    assertEquals(refused.refused_kind_version_id, null);
    assertEquals(refused.current_version_id, null);
    const listed = await listedVersionIds(fixture, published.artifactId);
    assertEquals(listed[0].refusedReason, "probe-abandoned");
  }));

/** A storage file over the artifact, so the storage routes can read it. */
async function storageFile(fixture: WorkerFixture, artifactId: string) {
  const folder = await fixture.pgDatabase.query<{ id: string }>(
    "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy) values ($1, null, $2, $2, 'folder', 'record') returning id",
    [fixture.organizationId, "staged-" + crypto.randomUUID().slice(0, 8)],
  );
  const entry = await fixture.pgDatabase.query<{ id: string }>(
    "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy, artifact_id) values ($1, $2, 'still.png', 'still.png', 'file', 'record', $3) returning id",
    [fixture.organizationId, folder.rows[0].id, artifactId],
  );
  return entry.rows[0].id;
}

async function getStorage(fixture: WorkerFixture, path: string) {
  return await fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, {
      headers: {
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
      },
    }),
  );
}

Deno.test("a staged version is not in a storage file's history and is not read by revision", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seedTask(fixture);
    // Published before the kind has a probe-backed rule, so it is current.
    const first = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Storage probe",
      bytes: bytes("published bytes"),
    });
    assertEquals(first.publicationStatus, "current");
    await publishKind(fixture, IMAGE_KIND_RULES);
    const second = await publish(fixture, seeded, {
      artifactType: "image",
      name: "Storage probe",
      bytes: bytes("staged bytes"),
    });
    assertEquals(second.publicationStatus, "staged");
    const revisions = await fixture.pgDatabase.query<
      { id: string; revision: number }
    >(
      "select id, revision from bakery.artifact_versions where organization_id = $1 and artifact_id = $2",
      [fixture.organizationId, first.artifactId],
    );
    const revisionOf = (id: string) =>
      revisions.rows.find((row) => row.id === id)!.revision;
    const fileId = await storageFile(fixture, first.artifactId);

    const history = await getStorage(
      fixture,
      `/v1/storage/files/${fileId}/versions`,
    );
    assertEquals(history.status, 200, await history.clone().text());
    const page = await history.json() as { items: { revision: number }[] };
    assertEquals(
      page.items.map((item) => item.revision),
      [revisionOf(first.versionId)],
    );

    const staged = revisionOf(second.versionId);
    const content = await getStorage(
      fixture,
      `/v1/storage/files/${fileId}/content?revision=${staged}`,
    );
    await content.body?.cancel();
    assertEquals(content.status, 404);
    const published = await getStorage(
      fixture,
      `/v1/storage/files/${fileId}/content?revision=${
        revisionOf(first.versionId)
      }`,
    );
    assertEquals(await published.text(), "published bytes");

    const probeRead = await getStorage(
      fixture,
      `/v1/storage/files/${fileId}/probe?revision=${staged}&organizationId=${fixture.organizationId}`,
    );
    assertEquals(probeRead.status, 404, await probeRead.text());
  }));

/** A current version and, after the kind gains a probe-backed rule, a staged one. */
async function currentAndStaged(fixture: WorkerFixture, name: string) {
  const seeded = await seedTask(fixture);
  const current = await publish(fixture, seeded, {
    artifactType: "image",
    name,
    bytes: bytes("published bytes"),
  });
  assertEquals(current.publicationStatus, "current");
  await publishKind(fixture, IMAGE_KIND_RULES);
  const staged = await publish(fixture, seeded, {
    artifactType: "image",
    name,
    bytes: bytes("staged bytes"),
  });
  assertEquals(staged.publicationStatus, "staged");
  return { current: current.versionId, staged: staged.versionId };
}

for (
  const [label, suffix] of [
    ["the comments list", "comments"],
    ["extraction", "extract"],
    ["mention candidates", "mention-candidates"],
  ] as const
) {
  Deno.test(`${label} does not find a staged version, and finds the current one`, () =>
    withWorkerFixture(async (fixture) => {
      const versions = await currentAndStaged(fixture, "Reader " + suffix);
      const staged = await getStorage(
        fixture,
        `/v1/artifact-versions/${versions.staged}/${suffix}`,
      );
      const current = await getStorage(
        fixture,
        `/v1/artifact-versions/${versions.current}/${suffix}`,
      );
      await staged.body?.cancel();
      await current.body?.cancel();
      assertEquals(staged.status, 404);
      assert(
        current.status !== 404,
        `the current version must be found (${current.status})`,
      );
    }));
}

Deno.test("extraction's identity read does not find a staged version", () =>
  withWorkerFixture(async (fixture) => {
    const versions = await currentAndStaged(fixture, "Identity read");
    await withPgTransaction(fixture.pgDatabase, async (transaction) => {
      const found = await readArtifactVersionIdentity(
        transaction,
        fixture.organizationId,
        versions.current,
      );
      assertEquals(found.id, versions.current);
      const missing = await assertRejects(() =>
        readArtifactVersionIdentity(
          transaction,
          fixture.organizationId,
          versions.staged,
        )
      );
      assertEquals((missing as { code?: string }).code, "RESOURCE_NOT_FOUND");
    });
  }));

Deno.test("a version refused between extraction's identity read and its byte read is not extracted", () =>
  withWorkerFixture(async (fixture) => {
    const versions = await currentAndStaged(fixture, "Refused mid-read");
    await withPgTransaction(fixture.pgDatabase, async (transaction) => {
      // The probe runner refuses the version once the identity read has passed,
      // so only the byte read's own filter stands between it and the caller.
      let refused = false;
      const racing = new Proxy(transaction, {
        get(target, property, receiver) {
          if (property !== "query") {
            return Reflect.get(target, property, receiver);
          }
          return async (...args: Parameters<typeof transaction.query>) => {
            const result = await target.query(...args);
            if (
              !refused && String(args[0]).includes("v.purged_at,v.artifact_id")
            ) {
              refused = true;
              await target.query(
                "update bakery.artifact_versions set publication_status = 'refused' where id = $1",
                [versions.current],
              );
            }
            return result;
          };
        },
      });
      const context = {
        params: { id: versions.current },
        authority: {
          organizationId: fixture.organizationId,
          subject: { principalId: fixture.principalId },
        },
        transaction: racing,
      } as unknown as ActionContext;
      const error = await assertRejects(() =>
        extractArtifactVersion(context, { startByte: 0, maxBytes: 64 })
      );
      assert(refused, "the identity read never ran");
      assertEquals((error as { code?: string }).code, "RESOURCE_NOT_FOUND");
    });
  }));
