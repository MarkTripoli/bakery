/**
 * #42 [B13.04] security probes: an Admin who is not a personal skill's owner
 * cannot read, author, copy, draft, grant or trace it, and every refusal is
 * the not-found an unknown id gets, so it reveals neither the skill nor its name.
 */
import { assert, assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

Deno.test("another member's personal skill answers every probe exactly like an unknown id", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "hidden-ledger",
      name: "Hidden ledger",
      scope: "personal",
    }, "sec-create");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string; version: number };
    const version = await f.insertSkillVersion(skill.id);
    const unknown = crypto.randomUUID();

    const probes = (id: string) => [
      () => f.read(f.adminCookie, `/v1/skills/${id}`),
      () => f.read(f.adminCookie, `/v1/skills/${id}/used-by`),
      () => f.read(f.adminCookie, `/v1/skills/${id}/use-grants`),
      () => f.read(f.adminCookie, `/v1/skills/${id}/draft`),
      () =>
        f.post(f.adminCookie, `/v1/skills/${id}/draft`, {}, `sec-draft-${id}`),
      () =>
        f.post(f.adminCookie, `/v1/skills/${id}/copy`, {
          name: "Taken",
          scope: "organization",
        }, `sec-copy-${id}`),
      () =>
        f.patch(
          f.adminCookie,
          `/v1/skills/${id}`,
          { name: "Renamed" },
          `sec-rename-${id}`,
          skill.version,
        ),
    ];
    const hidden = probes(skill.id);
    const absent = probes(unknown);
    for (const [index, probe] of hidden.entries()) {
      const response = await probe();
      const text = await response.text();
      const baseline = await absent[index]();
      await baseline.body?.cancel();
      assertEquals(response.status, baseline.status, `probe ${index}: ${text}`);
      assertEquals(response.status, 404, `probe ${index}: ${text}`);
      assert(!text.includes("Hidden ledger"), `probe ${index} leaks the name`);
      assert(!text.includes(version), `probe ${index} leaks the version`);
    }

    // The skill and its version are unchanged and nothing was copied.
    const rows = await f.fixture.pgDatabase.query<{ name: string; n: number }>(
      `select name,
              (select count(*)::int from bakery.skills
                where copied_from_skill_id = $1) as n
         from bakery.skills where id = $1`,
      [skill.id],
    );
    assertEquals(rows.rows[0], { name: "Hidden ledger", n: 0 });
    // The owner still reads it.
    const own = await f.fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}`, {
        headers: {
          cookie: f.ownerCookie,
          "Bakery-Organization-Id": f.organizationId,
        },
      }),
    );
    assertEquals(own.status, 200);
  } finally {
    await f.close();
  }
});

Deno.test("an Admin cannot change a Bakery skill, nor rename or switch off the source that carries it", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-42-global-source-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  const send = (
    method: string,
    path: string,
    body: unknown,
    key: string,
    version: number,
  ) =>
    f.fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers: {
          cookie: f.ownerCookie,
          "Bakery-Organization-Id": f.organizationId,
          "content-type": "application/json",
          origin: authTestOrigin,
          "Idempotency-Key": key,
          "If-Match": `"${version}"`,
        },
        body: JSON.stringify(body),
      }),
    );
  try {
    // Listing installs Bakery's own skills the first time.
    assertEquals((await f.read(f.ownerCookie, "/v1/skills")).status, 200);
    const list = await f.read(f.ownerCookie, "/v1/skills?scope=global");
    const { items } = await list.json() as {
      items: Array<
        { id: string; sourceId: string; version: number; name: string }
      >;
    };
    assert(items.length > 0, "no Bakery skill was installed");
    const skill = items[0];
    const sourceRead = await f.read(
      f.ownerCookie,
      `/v1/skill-sources/${skill.sourceId}`,
    );
    const source = await sourceRead.json() as {
      version: number;
      name: string;
      enabled: boolean;
    };
    const refused = [
      await send(
        "PATCH",
        `/v1/skills/${skill.id}`,
        { enabled: false },
        "g-skill-off",
        skill.version,
      ),
      await send(
        "PATCH",
        `/v1/skills/${skill.id}`,
        { name: "Hijacked" },
        "g-skill-name",
        skill.version,
      ),
      await send(
        "PATCH",
        `/v1/skill-sources/${skill.sourceId}`,
        { enabled: false },
        "g-source-off",
        source.version,
      ),
      await send(
        "PATCH",
        `/v1/skill-sources/${skill.sourceId}`,
        { name: "Hijacked" },
        "g-source-name",
        source.version,
      ),
    ];
    for (const response of refused) {
      assertEquals(response.status, 403);
      const problem = await response.json() as { reason?: string };
      assertEquals(problem.reason, "global_skill_is_read_only");
    }
    const after = await (await f.read(
      f.ownerCookie,
      `/v1/skill-sources/${skill.sourceId}`,
    )).json() as typeof source;
    assertEquals(after, source);
    const skillAfter = await (await f.read(
      f.ownerCookie,
      `/v1/skills/${skill.id}`,
    )).json() as { enabled: boolean; name: string };
    assertEquals([skillAfter.enabled, skillAfter.name], [true, skill.name]);
  } finally {
    await f.close();
    await Deno.remove(root, { recursive: true });
  }
});
