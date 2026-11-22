/**
 * #74 rev 3 server needs: skills.list name search bound into its cursor, a
 * skill's description returned by get and list, the list of a skill's
 * versions, and putting an older published version in use without moving any
 * workflow pin.
 */
import { assert, assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Skill = {
  id: string;
  name: string;
  description: string | null;
  activeVersionId: string | null;
  version: number;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Version = { id: string; revision: number; status: string };

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function upload(text: string, revision: number) {
  const bytes = encoder.encode(text);
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      sha256: await sha256(bytes),
      isExecutable: false,
    }],
  };
  return {
    revision,
    digest: await sha256(encoder.encode(canonicalJson(manifest))),
    entryPath: "SKILL.md",
    manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      isExecutable: false,
      contentBase64: btoa(String.fromCharCode(...bytes)),
    }],
  };
}

function call(
  f: Fx,
  cookie: string,
  method: string,
  path: string,
  options: { body?: unknown; key?: string; version?: number } = {},
) {
  return f.fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers: {
        cookie,
        "Bakery-Organization-Id": f.organizationId,
        "content-type": "application/json",
        origin: authTestOrigin,
        ...(options.key === undefined
          ? {}
          : { "Idempotency-Key": options.key }),
        ...(options.version === undefined
          ? {}
          : { "If-Match": `"${options.version}"` }),
      },
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    }),
  );
}

async function json<T>(response: Response, status = 200): Promise<T> {
  assertEquals(response.status, status, await response.clone().text());
  return await response.json() as T;
}

Deno.test("skills.list finds skills by name, and its cursor belongs to that search", async () => {
  const f = await openPersonalSkillFixture();
  try {
    for (
      const [slug, name] of [
        ["alpha-research", "Alpha research"],
        ["beta-notes", "Beta notes"],
        ["second-alpha", "The ALPHA two"],
        ["percent", "100% sure"],
      ]
    ) {
      await json(
        await f.post(f.ownerCookie, "/v1/skills", { slug, name }, `q-${slug}`),
        201,
      );
    }
    const names = async (query: string) =>
      (await json<Page<Skill>>(
        await f.read(f.ownerCookie, `/v1/skills?${query}`),
      )).items.map((skill) => skill.name);
    assertEquals(await names("q=alpha"), ["The ALPHA two", "Alpha research"]);
    assertEquals(await names("q=BETA"), ["Beta notes"]);
    // A percent sign is text, not a wildcard.
    assertEquals(await names("q=%25"), ["100% sure"]);
    assertEquals(await names("q=zzz"), []);

    const first = await json<Page<Skill>>(
      await f.read(f.ownerCookie, "/v1/skills?q=alpha&limit=1"),
    );
    assertEquals(first.items.map((skill) => skill.name), ["The ALPHA two"]);
    assert(first.nextCursor !== null);
    const cursor = encodeURIComponent(first.nextCursor);
    const second = await json<Page<Skill>>(
      await f.read(
        f.ownerCookie,
        `/v1/skills?q=alpha&limit=1&cursor=${cursor}`,
      ),
    );
    assertEquals(second.items.map((skill) => skill.name), ["Alpha research"]);
    assertEquals(second.nextCursor, null);
    // The same cursor with other text, or with none, is refused.
    for (const query of [`q=beta&cursor=${cursor}`, `cursor=${cursor}`]) {
      const refused = await f.read(f.ownerCookie, `/v1/skills?${query}`);
      assertEquals(refused.status, 400, await refused.clone().text());
    }
  } finally {
    await f.close();
  }
});

Deno.test("a skill's description is kept and returned by get and list", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const skill = await json<Skill>(
      await f.post(f.ownerCookie, "/v1/skills", {
        slug: "described",
        name: "Described",
      }, "desc-create"),
      201,
    );
    assertEquals(skill.description, null);
    const updated = await json<Skill>(
      await f.patch(
        f.ownerCookie,
        `/v1/skills/${skill.id}`,
        { description: "Finds sources before writing." },
        "desc-update",
        skill.version,
      ),
    );
    assertEquals(updated.description, "Finds sources before writing.");
    const got = await json<Skill>(
      await f.read(f.ownerCookie, `/v1/skills/${skill.id}`),
    );
    assertEquals(got.description, "Finds sources before writing.");
    const listed = await json<Page<Skill>>(
      await f.read(f.ownerCookie, "/v1/skills?q=described"),
    );
    assertEquals(listed.items[0].description, "Finds sources before writing.");
  } finally {
    await f.close();
  }
});

Deno.test("a skill's versions are listed newest first, to whoever can see the skill", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-versions-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const skill = await json<Skill>(
      await f.post(f.ownerCookie, "/v1/skills", {
        slug: "versioned",
        name: "Versioned",
        scope: "personal",
      }, "versions-create"),
      201,
    );
    const published: Version[] = [];
    for (const revision of [1, 2, 3]) {
      published.push(
        await json<Version>(
          await f.post(
            f.ownerCookie,
            `/v1/skills/${skill.id}/versions`,
            await upload(`# Versioned\n\nRevision ${revision}.\n`, revision),
            `versions-v${revision}`,
          ),
          201,
        ),
      );
    }
    const path = `/v1/skills/${skill.id}/versions`;
    const all = await json<Page<Version>>(await f.read(f.ownerCookie, path));
    assertEquals(all.items.map((item) => item.revision), [3, 2, 1]);
    assertEquals(all.items.map((item) => item.status), [
      "published",
      "published",
      "published",
    ]);
    // Pages of two, then the rest.
    const first = await json<Page<Version>>(
      await f.read(f.ownerCookie, `${path}?limit=2`),
    );
    assertEquals(first.items.map((item) => item.revision), [3, 2]);
    assert(first.nextCursor !== null);
    const rest = await json<Page<Version>>(
      await f.read(
        f.ownerCookie,
        `${path}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      ),
    );
    assertEquals(rest.items.map((item) => item.revision), [1]);
    assertEquals(rest.nextCursor, null);
    // Someone else's personal skill: its versions are not found either.
    assertEquals((await f.read(f.adminCookie, path)).status, 404);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an older published version can be put in use, explicitly and once, and no workflow pin moves", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-74-active-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const skill = await json<Skill>(
      await f.post(f.ownerCookie, "/v1/skills", {
        slug: "switchable",
        name: "Switchable",
      }, "active-create"),
      201,
    );
    const versions: Version[] = [];
    for (const revision of [1, 2]) {
      versions.push(
        await json<Version>(
          await f.post(
            f.ownerCookie,
            `/v1/skills/${skill.id}/versions`,
            await upload(`# Switchable\n\nRevision ${revision}.\n`, revision),
            `active-v${revision}`,
          ),
          201,
        ),
      );
    }
    const [v1, v2] = versions;
    // A published workflow version pins v2.
    const workflow = await json<{ id: string }>(
      await f.post(f.ownerCookie, "/v1/workflows", {
        slug: "pins-v2",
        name: "pins-v2",
        description: "pins-v2",
      }, "active-wf"),
      201,
    );
    const draft = await json<{ id: string; version: number }>(
      await f.post(f.ownerCookie, `/v1/workflows/${workflow.id}/versions`, {
        definition: {
          kind: "fixed",
          steps: [{
            id: "first",
            uses: "workflow.noop",
            action: "agent.run",
            skills: [v2.id],
          }],
        },
      }, "active-wf-draft"),
      201,
    );
    const pinned = await json<{ id: string }>(
      await call(
        f,
        f.ownerCookie,
        "POST",
        `/v1/workflows/${workflow.id}/versions/${draft.id}/publish`,
        { body: {}, key: "active-wf-pub", version: draft.version },
      ),
    );
    const before = await json<Skill>(
      await f.read(f.ownerCookie, `/v1/skills/${skill.id}`),
    );
    assertEquals(before.activeVersionId, v2.id);

    const path = `/v1/skills/${skill.id}/active-version`;
    // If-Match is required and a stale one is refused.
    assertEquals(
      (await call(f, f.ownerCookie, "POST", path, {
        body: { versionId: v1.id },
        key: "active-no-match",
      })).status,
      428,
    );
    assertEquals(
      (await call(f, f.ownerCookie, "POST", path, {
        body: { versionId: v1.id },
        key: "active-stale",
        version: before.version + 7,
      })).status,
      412,
    );
    const request = {
      body: { versionId: v1.id },
      key: "active-v1",
      version: before.version,
    };
    const switched = await json<Skill>(
      await call(f, f.ownerCookie, "POST", path, request),
    );
    assertEquals(switched.activeVersionId, v1.id);
    const replay = await call(f, f.ownerCookie, "POST", path, request);
    assertEquals(replay.status, 200, await replay.clone().text());
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    const audits = await f.fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.audit_events
        where operation = 'skills.setActiveVersion' and resource_id::text = $1`,
      [skill.id],
    );
    assertEquals(audits.rows[0].count, 1);
    const events = await f.fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.domain_events
        where event_type = 'skills.updated' and aggregate_id::text = $1`,
      [skill.id],
    );
    assertEquals(events.rows[0].count, 1);

    // The workflow keeps the version it pinned.
    const spec = await f.fixture.pgDatabase.query<{ skills: unknown }>(
      `select normalized_spec #> '{steps,0,skills}' as skills
         from bakery.workflow_versions where id = $1`,
      [pinned.id],
    );
    assertEquals(spec.rows[0].skills, [v2.id]);

    // A version of another skill is not found; an unpublished one is a conflict.
    const other = await json<Skill>(
      await f.post(f.ownerCookie, "/v1/skills", {
        slug: "other",
        name: "Other",
      }, "active-other"),
      201,
    );
    const foreign = await f.insertSkillVersion(other.id);
    assertEquals(
      (await call(f, f.ownerCookie, "POST", path, {
        body: { versionId: foreign },
        key: "active-foreign",
        version: switched.version,
      })).status,
      404,
    );
    await f.fixture.pgDatabase.query(
      "update bakery.skill_versions set status = 'retired' where id = $1",
      [v2.id],
    );
    const retired = await call(f, f.ownerCookie, "POST", path, {
      body: { versionId: v2.id },
      key: "active-retired",
      version: switched.version,
    });
    assertEquals(retired.status, 409, await retired.clone().text());

    // An Admin who is not its owner cannot touch a personal skill, and nobody
    // changes a skill that comes with Bakery.
    await f.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'global' where id = $1",
      [skill.id],
    );
    const bakery = await call(f, f.ownerCookie, "POST", path, {
      body: { versionId: v1.id },
      key: "active-global",
      version: switched.version,
    });
    assertEquals(bakery.status, 403, await bakery.clone().text());
    assert((await bakery.text()).includes("global_skill_is_read_only"));
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});
