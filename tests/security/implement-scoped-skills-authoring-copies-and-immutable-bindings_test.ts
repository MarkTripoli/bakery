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
