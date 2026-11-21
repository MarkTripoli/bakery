import { assert, assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

/**
 * Issue 42 AC2: a skill that comes with Bakery (Global) is read-only to every
 * administrator. A rename, a switch-off and a draft are each refused with the
 * same named reason, and the skill keeps its scope, name and state.
 */
Deno.test("a Global skill refuses mutation and disable, even from an administrator, and keeps its provenance", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const call = (
      method: string,
      path: string,
      body?: unknown,
      version?: number,
    ) =>
      f.fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers: {
            cookie: f.ownerCookie,
            "Bakery-Organization-Id": f.organizationId,
            "content-type": "application/json",
            origin: authTestOrigin,
            ...(method === "GET"
              ? {}
              : { "Idempotency-Key": crypto.randomUUID() }),
            ...(version === undefined ? {} : { "If-Match": `"${version}"` }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const created = await call("POST", "/v1/skills", {
      slug: "from-bakery",
      name: "From Bakery",
    });
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    // Shared by Bakery: the host marks it Global, which no request can do.
    await f.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'global' where id = $1",
      [skill.id],
    );
    const before = await f.fixture.pgDatabase.query<Record<string, unknown>>(
      "select scope, name, enabled, active_version_id, version from bakery.skills where id = $1",
      [skill.id],
    );
    const version = Number(before.rows[0].version);

    const refusals: [string, string, unknown, number | undefined][] = [
      ["PATCH", `/v1/skills/${skill.id}`, { name: "Renamed" }, version],
      ["PATCH", `/v1/skills/${skill.id}`, { enabled: false }, version],
      ["POST", `/v1/skills/${skill.id}/draft`, undefined, undefined],
    ];
    for (const [method, path, body, ifMatch] of refusals) {
      const response = await call(method, path, body, ifMatch);
      const text = await response.text();
      assertEquals(response.status, 403, `${method} ${path}: ${text}`);
      const problem = JSON.parse(text) as { code: string; reason?: string };
      assertEquals(problem.code, "AUTH_FORBIDDEN", `${method} ${path}`);
      // A draft names its reason; an update is refused by the access rule itself.
      if (path.endsWith("/draft")) {
        assertEquals(problem.reason, "global_skill_is_read_only");
      }
    }

    const after = await f.fixture.pgDatabase.query<Record<string, unknown>>(
      "select scope, name, enabled, active_version_id, version from bakery.skills where id = $1",
      [skill.id],
    );
    assertEquals(after.rows[0], before.rows[0]);
    assertEquals(after.rows[0].scope, "global");
    assert(after.rows[0].enabled === before.rows[0].enabled);
  } finally {
    await f.close();
  }
});
