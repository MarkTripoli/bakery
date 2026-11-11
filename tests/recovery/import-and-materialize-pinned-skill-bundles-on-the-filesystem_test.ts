import { assertEquals, assertRejects } from "@std/assert";
import { dirname } from "node:path";
import {
  deriveSkillVersionId,
  skillObjectKey,
} from "../../apps/server/src/modules/catalog/identity.ts";
import {
  SkillFileStore,
  SkillFileStoreError,
} from "../../apps/server/src/modules/catalog/storage.ts";
import {
  assertProblem,
  makeUpload,
  openPublicationTestContext,
  type PublicationIdentity,
  sha256,
} from "../helpers/local-skill-publication.ts";
import { authTestOrigin } from "../helpers/auth.ts";

async function committedFacts(
  context: Awaited<ReturnType<typeof openPublicationTestContext>>,
  skillId: string,
  versionId: string,
  idempotencyKey: string,
) {
  const result = await context.fixture.pgDatabase.query<{
    versions: number;
    files: number;
    events: number;
    audits: number;
    outbox: number;
    idempotency: number;
  }>(
    `select
       (select count(*)::int from bakery.skill_versions
         where organization_id = $1 and skill_id = $2 and id = $3) as versions,
       (select count(*)::int from bakery.skill_files
         where organization_id = $1 and skill_version_id = $3) as files,
       (select count(*)::int from bakery.domain_events
         where organization_id = $1 and aggregate_id = $3
           and event_type = 'skill.version_created') as events,
       (select count(*)::int from bakery.audit_events
         where organization_id = $1 and resource_id = $3::text
           and operation = 'skillVersions.create') as audits,
       (select count(*)::int from bakery.outbox as outbox
         join bakery.domain_events as event on event.id = outbox.event_id
        where outbox.organization_id = $1 and event.aggregate_id = $3) as outbox,
       (select count(*)::int from bakery.idempotency_records
         where organization_id = $1 and operation = 'skillVersions.create'
           and key = $4) as idempotency`,
    [context.organizationId, skillId, versionId, idempotencyKey],
  );
  return result.rows[0];
}

async function assertOrphanUnreadable(
  context: Awaited<ReturnType<typeof openPublicationTestContext>>,
  skillId: string,
) {
  const skillResponse = await context.fixture.app.fetch(
    new Request(`${authTestOrigin}/v1/skills/${skillId}`, {
      headers: context.headers,
    }),
  );
  assertEquals(skillResponse.status, 200);
  assertEquals(
    (await skillResponse.json() as { activeVersionId: string | null })
      .activeVersionId,
    null,
  );
  const metadata = await context.fixture.pgDatabase.query<{
    versions: number;
    files: number;
  }>(
    `select
       (select count(*)::int from bakery.skill_versions
         where organization_id = $1 and skill_id = $2) as versions,
       (select count(*)::int from bakery.skill_files
         where organization_id = $1) as files`,
    [context.organizationId, skillId],
  );
  assertEquals(metadata.rows[0], { versions: 0, files: 0 });
}

for (
  const boundary of ["after-one-link", "after-all-links"] as const
) {
  Deno.test(`restart recovers exact two-link orphan ${boundary}`, async () => {
    const root = await Deno.makeTempDir({ prefix: `bakery-277-${boundary}-` });
    let links = 0;
    const crashAt = boundary === "after-one-link" ? 1 : 2;
    const crashingStore = new SkillFileStore(root, Deno.uid() ?? 0, {
      hooks: {
        afterLink: () => {
          links += 1;
          return links === crashAt ? "simulate-crash" : undefined;
        },
      },
    });
    let context:
      | Awaited<ReturnType<typeof openPublicationTestContext>>
      | undefined;
    let identity: PublicationIdentity | undefined;
    try {
      context = await openPublicationTestContext({
        root,
        store: crashingStore,
      });
      identity = context.identity;
      const skill = await context.createSkill(`phase3-${boundary}`);
      const contents = [
        new TextEncoder().encode("first object bytes\n"),
        new TextEncoder().encode("second object bytes\n"),
      ];
      const upload = await makeUpload([
        { path: "SKILL.md", content: contents[0] },
        { path: "references/recovery.md", content: contents[1] },
      ]);
      const versionId = await deriveSkillVersionId({
        organizationId: context.organizationId,
        skillId: skill.id,
        revision: 1,
        digest: upload.digest,
      });
      const keys = await Promise.all(
        contents.map(async (content) =>
          skillObjectKey(
            context!.organizationId,
            versionId,
            await sha256(content),
          )
        ),
      );
      const idempotencyKey = `phase3-${boundary}`;
      await assertProblem(
        await context.publish(skill.id, upload, idempotencyKey),
        503,
        "DEPENDENCY_UNAVAILABLE",
        [root, ...keys],
      );
      await assertOrphanUnreadable(context, skill.id);

      const linkedCount = boundary === "after-one-link" ? 1 : 2;
      for (let index = 0; index < linkedCount; index++) {
        const stat = await Deno.lstat(`${root}/${keys[index]}`);
        assertEquals(stat.nlink, index === crashAt - 1 ? 2 : 1);
      }
      if (boundary === "after-one-link") {
        await assertRejects(
          () => Deno.lstat(`${root}/${keys[1]}`),
          Deno.errors.NotFound,
        );
      }
      const interruptedParent = dirname(`${root}/${keys[crashAt - 1]}`);
      assertEquals(
        Array.from(Deno.readDirSync(interruptedParent)).filter(({ name }) =>
          name.startsWith(".bakery-tmp-")
        ).length,
        1,
      );

      await context.close();
      context = await openPublicationTestContext({ root, identity });
      const retried = await context.publish(skill.id, upload, idempotencyKey);
      assertEquals(retried.status, 201, await retried.clone().text());
      assertEquals((await retried.json() as { id: string }).id, versionId);
      assertEquals(
        await committedFacts(context, skill.id, versionId, idempotencyKey),
        {
          versions: 1,
          files: 2,
          events: 1,
          audits: 1,
          outbox: 1,
          idempotency: 1,
        },
      );
      for (const key of keys) {
        assertEquals((await Deno.lstat(`${root}/${key}`)).nlink, 1);
      }
      assertEquals(
        Array.from(Deno.readDirSync(interruptedParent)).some(({ name }) =>
          name.startsWith(".bakery-tmp-")
        ),
        false,
      );
    } finally {
      await context?.close(true);
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("restart reuses exact identity after readback before finalization", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-after-readback-" });
  const realStore = new SkillFileStore(root);
  let interrupt = true;
  const crashingStore = {
    recover: realStore.recover.bind(realStore),
    putIfAbsent: realStore.putIfAbsent.bind(realStore),
    async read(key: string, digest: string, size: number) {
      const bytes = await realStore.read(key, digest, size);
      if (interrupt) {
        interrupt = false;
        throw new Error("SIMULATED_CRASH_AFTER_READBACK");
      }
      return bytes;
    },
  };
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  try {
    context = await openPublicationTestContext({ root, store: crashingStore });
    const identity = context.identity;
    const skill = await context.createSkill("phase3-after-readback");
    const content = new TextEncoder().encode("read back before metadata\n");
    const upload = await makeUpload([{ path: "SKILL.md", content }]);
    const versionId = await deriveSkillVersionId({
      organizationId: context.organizationId,
      skillId: skill.id,
      revision: 1,
      digest: upload.digest,
    });
    const key = skillObjectKey(
      context.organizationId,
      versionId,
      await sha256(content),
    );
    const idempotencyKey = "phase3-after-readback";
    await assertProblem(
      await context.publish(skill.id, upload, idempotencyKey),
      503,
      "DEPENDENCY_UNAVAILABLE",
      [root, key],
    );
    await assertOrphanUnreadable(context, skill.id);
    assertEquals(await Deno.readFile(`${root}/${key}`), content);

    await context.close();
    context = await openPublicationTestContext({ root, identity });
    const retried = await context.publish(skill.id, upload, idempotencyKey);
    assertEquals(retried.status, 201, await retried.clone().text());
    assertEquals((await retried.json() as { id: string }).id, versionId);
    assertEquals(
      await committedFacts(context, skill.id, versionId, idempotencyKey),
      {
        versions: 1,
        files: 1,
        events: 1,
        audits: 1,
        outbox: 1,
        idempotency: 1,
      },
    );
  } finally {
    await context?.close(true);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lost response restarts into committed replay with no object reads", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-after-commit-" });
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  try {
    context = await openPublicationTestContext({ root });
    const identity = context.identity;
    const skill = await context.createSkill("phase3-after-commit");
    const upload = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("commit survives lost response\n"),
    }]);
    const versionId = await deriveSkillVersionId({
      organizationId: context.organizationId,
      skillId: skill.id,
      revision: 1,
      digest: upload.digest,
    });
    const idempotencyKey = "phase3-after-commit";
    const lostResponse = await context.publish(
      skill.id,
      upload,
      idempotencyKey,
    );
    assertEquals(lostResponse.status, 201);
    // Simulate transport loss: close the app without consuming the committed response.
    await context.close();

    const objectCalls: string[] = [];
    const store = {
      recover() {
        objectCalls.push("recover");
        return Promise.reject(new Error("COMMITTED_REPLAY_TOUCHED_STORAGE"));
      },
      putIfAbsent() {
        objectCalls.push("put");
        return Promise.reject(new Error("COMMITTED_REPLAY_TOUCHED_STORAGE"));
      },
      read() {
        objectCalls.push("read");
        return Promise.reject(new Error("COMMITTED_REPLAY_TOUCHED_STORAGE"));
      },
    };
    context = await openPublicationTestContext({ root, identity, store });
    const replay = await context.publish(skill.id, upload, idempotencyKey);
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals((await replay.json() as { id: string }).id, versionId);
    assertEquals(objectCalls, []);
    assertEquals(
      await committedFacts(context, skill.id, versionId, idempotencyKey),
      {
        versions: 1,
        files: 1,
        events: 1,
        audits: 1,
        outbox: 1,
        idempotency: 1,
      },
    );
  } finally {
    await context?.close(true);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("recovery fails closed for unknown links, changed parents, symlinks, non-files, and mismatch", async () => {
  const content = new TextEncoder().encode("immutable recovery bytes\n");
  const digest = await sha256(content);
  const key = skillObjectKey(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    digest,
  );

  const withRoot = async (run: (root: string) => Promise<void>) => {
    const root = await Deno.makeTempDir({
      prefix: "bakery-277-recovery-invalid-",
    });
    try {
      await run(root);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  };

  await withRoot(async (root) => {
    const store = new SkillFileStore(root);
    await store.putIfAbsent(key, content, digest);
    await Deno.link(`${root}/${key}`, `${root}/${key}.unknown`);
    await assertRejects(
      () => store.recover(key, digest, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_ORPHAN_UNSAFE",
    );
  });

  await withRoot(async (root) => {
    const crashing = new SkillFileStore(root, Deno.uid() ?? 0, {
      hooks: { afterLink: () => "simulate-crash" },
    });
    await assertRejects(
      () => crashing.putIfAbsent(key, content, digest),
      Error,
      "SKILL_FILE_STORE_SIMULATED_CRASH",
    );
    let moved = "";
    const changed = new SkillFileStore(root, Deno.uid() ?? 0, {
      hooks: {
        beforeRecoverUnlink: async ({ parent }) => {
          moved = `${parent}.moved`;
          await Deno.rename(parent, moved);
          await Deno.mkdir(parent, { mode: 0o700 });
        },
      },
    });
    await assertRejects(
      () => changed.recover(key, digest, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_PARENT_CHANGED",
    );
    assertEquals(moved.length > 0, true);
  });

  await withRoot(async (root) => {
    const store = new SkillFileStore(root);
    await store.putIfAbsent(key, content, digest);
    const path = `${root}/${key}`;
    await Deno.remove(path);
    await Deno.symlink("/etc/passwd", path);
    await assertRejects(
      () => store.recover(key, digest, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_SYMLINK",
    );
  });

  await withRoot(async (root) => {
    const store = new SkillFileStore(root);
    await store.putIfAbsent(key, content, digest);
    const path = `${root}/${key}`;
    await Deno.remove(path);
    await Deno.mkdir(path, { mode: 0o700 });
    await assertRejects(
      () => store.recover(key, digest, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_OBJECT_UNSAFE",
    );
  });

  await withRoot(async (root) => {
    const store = new SkillFileStore(root);
    await store.putIfAbsent(key, content, digest);
    await Deno.writeTextFile(`${root}/${key}`, "mismatch", { mode: 0o600 });
    await assertRejects(
      () => store.recover(key, digest, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_OBJECT_UNSAFE",
    );
  });
});
