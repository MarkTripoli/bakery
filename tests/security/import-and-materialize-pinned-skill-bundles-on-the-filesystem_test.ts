import { createPrivateFixtureSymlink } from "../helpers/private-symlink-fixture.ts";
import { assertEquals } from "@std/assert";
import { basename } from "node:path";
import {
  deriveSkillVersionId,
  skillObjectKey,
} from "../../apps/server/src/modules/catalog/identity.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  assertProblem,
  makeUpload,
  openPublicationTestContext,
  sha256,
  type TestUpload,
} from "../helpers/local-skill-publication.ts";
import { authTestOrigin } from "../helpers/auth.ts";

Deno.test("authenticated publication rejects hostile callers and bundle boundaries without metadata", async () => {
  const root = await Deno.makeTempDir({
    prefix: "bakery-277-phase3-security-",
  });
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  try {
    context = await openPublicationTestContext({ root });
    const skill = await context.createSkill("phase3-hostile-bundles");
    const baseline = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("# hostile boundary proof\n"),
    }]);
    const endpoint = `${authTestOrigin}/v1/skills/${skill.id}/versions`;
    const unauthenticated = await context.fixture.app.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: authTestOrigin,
          "content-type": "application/json",
          "Bakery-Organization-Id": context.organizationId,
          "Idempotency-Key": "phase3-unauthenticated",
        },
        body: JSON.stringify(baseline),
      }),
    );
    await assertProblem(unauthenticated, 401, "AUTH_REQUIRED", [root]);

    await context.fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'developer'
        where organization_id = $1 and principal_id = $2`,
      [context.organizationId, context.principalId],
    );
    await assertProblem(
      await context.publish(skill.id, baseline, "phase3-developer"),
      403,
      "AUTH_FORBIDDEN",
      [root],
    );
    await context.fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'admin'
        where organization_id = $1 and principal_id = $2`,
      [context.organizationId, context.principalId],
    );

    const foreign = await context.publish(
      skill.id,
      baseline,
      "phase3-foreign-tenant",
      { "Bakery-Organization-Id": crypto.randomUUID() },
    );
    await assertProblem(foreign, 404, "RESOURCE_NOT_FOUND", [root]);

    const hostile: Array<[string, TestUpload]> = [];
    const traversal = structuredClone(baseline);
    traversal.files[0].path = "../SKILL.md";
    hostile.push(["traversal", traversal]);
    hostile.push([
      "collision",
      await makeUpload([
        { path: "A.md", content: new Uint8Array([1]) },
        { path: "a.md", content: new Uint8Array([2]) },
      ]),
    ]);
    const executable = structuredClone(baseline);
    executable.files[0].isExecutable = true;
    hostile.push(["executable", executable]);
    const license = structuredClone(baseline);
    license.manifest.license = "MIT\nsecret";
    hostile.push(["license", license]);
    const digest = structuredClone(baseline);
    digest.digest = "f".repeat(64);
    hostile.push(["digest", digest]);

    for (const [name, upload] of hostile) {
      const transportRejected = name === "traversal";
      await assertProblem(
        await context.publish(skill.id, upload, `phase3-hostile-${name}`),
        transportRejected ? 400 : 422,
        transportRejected ? "MALFORMED_REQUEST" : "UNPROCESSABLE",
        [root, "secret", "organizations/"],
      );
    }
    const empty = await context.fixture.pgDatabase.query<{
      versions: number;
      files: number;
      idempotency: number;
    }>(
      `select
         (select count(*)::int from bakery.skill_versions
           where organization_id = $1 and skill_id = $2) as versions,
         (select count(*)::int from bakery.skill_files
           where organization_id = $1) as files,
         (select count(*)::int from bakery.idempotency_records
           where organization_id = $1 and operation = 'skillVersions.create')
           as idempotency`,
      [context.organizationId, skill.id],
    );
    assertEquals(empty.rows[0], { versions: 0, files: 0, idempotency: 0 });

    const licenseSkill = await context.createSkill("phase3-license-boundary");
    const first = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("first license\n"),
    }]);
    const firstResponse = await context.publish(
      licenseSkill.id,
      first,
      "phase3-license-first",
    );
    assertEquals(firstResponse.status, 201, await firstResponse.clone().text());
    const changed = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("changed license\n"),
    }], { revision: 2, license: "Apache-2.0" });
    await assertProblem(
      await context.publish(
        licenseSkill.id,
        changed,
        "phase3-license-changed",
      ),
      409,
      "STATE_CONFLICT",
      [root, changed.digest],
    );
  } finally {
    await context?.close(true);
    await Deno.remove(root, { recursive: true });
  }
});

for (const swap of ["before-link", "after-link"] as const) {
  Deno.test(`publication rejects an actual parent symlink swap ${swap}`, async () => {
    const root = await Deno.makeTempDir({ prefix: `bakery-277-${swap}-` });
    const external = await Deno.makeTempDir({
      prefix: `bakery-277-${swap}-outside-`,
    });
    const content = new TextEncoder().encode("published bytes stay private\n");
    let movedParent = "";
    let externalDestination = "";
    let externalBytes = new Uint8Array();
    let armed = false;
    const swapParent = async (paths: {
      parent: string;
      destination: string;
    }) => {
      if (!armed) return;
      armed = false;
      movedParent = `${paths.parent}.moved`;
      await Deno.rename(paths.parent, movedParent);
      externalDestination = `${external}/${basename(paths.destination)}`;
      externalBytes = new Uint8Array(content.byteLength).fill(88);
      await Deno.writeFile(externalDestination, externalBytes, { mode: 0o600 });
      await createPrivateFixtureSymlink(external, paths.parent);
    };
    const store = new SkillFileStore(root, Deno.uid() ?? 0, {
      hooks: swap === "before-link"
        ? { beforeLink: swapParent }
        : { afterLink: swapParent },
    });
    let context:
      | Awaited<ReturnType<typeof openPublicationTestContext>>
      | undefined;
    try {
      context = await openPublicationTestContext({ root, store });
      const skill = await context.createSkill(`phase3-${swap}`);
      const upload = await makeUpload([{ path: "SKILL.md", content }]);
      const versionId = await deriveSkillVersionId({
        organizationId: context.organizationId,
        skillId: skill.id,
        revision: 1,
        digest: upload.digest,
      });
      const objectKey = skillObjectKey(
        context.organizationId,
        versionId,
        await sha256(content),
      );
      armed = true;
      const response = await context.publish(
        skill.id,
        upload,
        `phase3-${swap}`,
      );
      await assertProblem(response, 503, "DEPENDENCY_UNAVAILABLE", [
        root,
        external,
        objectKey,
        "published bytes stay private",
      ]);
      assertEquals(await Deno.readFile(externalDestination), externalBytes);
      const movedDestination = `${movedParent}/${
        basename(externalDestination)
      }`;
      if (swap === "before-link") {
        let exists = true;
        try {
          await Deno.lstat(movedDestination);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) exists = false;
          else throw error;
        }
        assertEquals(exists, false);
      } else {
        assertEquals(await Deno.readFile(movedDestination), content);
      }
      const metadata = await context.fixture.pgDatabase.query<{
        versions: number;
        files: number;
      }>(
        `select
           (select count(*)::int from bakery.skill_versions
             where organization_id = $1 and skill_id = $2) as versions,
           (select count(*)::int from bakery.skill_files
             where organization_id = $1) as files`,
        [context.organizationId, skill.id],
      );
      assertEquals(metadata.rows[0], { versions: 0, files: 0 });
    } finally {
      await context?.close(true);
      await Deno.remove(root, { recursive: true });
      await Deno.remove(external, { recursive: true });
    }
  });
}
