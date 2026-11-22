import { assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type SkillPage = {
  items: { slug: string; scope: string }[];
  nextCursor: string | null;
};

/**
 * Issue 74: the skill list can be asked for one scope. The filter happens in
 * the query, so a page is never short because other scopes filled it, and a
 * cursor from one scope's listing cannot be replayed against another's.
 */
Deno.test("skills.list filters by scope on the server and binds the cursor to it", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const call = (method: string, path: string, body?: unknown) =>
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
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const create = async (slug: string, scope?: string) => {
      const response = await call("POST", "/v1/skills", {
        slug,
        name: slug,
        ...(scope === undefined ? {} : { scope }),
      });
      assertEquals(response.status, 201, await response.clone().text());
      return await response.json() as { id: string };
    };
    await create("shared-a");
    await create("shared-b");
    await create("mine-a", "personal");
    const comes = await create("from-bakery");
    // Shared by Bakery: the host marks it Global, which no request can do.
    await f.fixture.pgDatabase.query(
      "update bakery.skills set scope = 'global' where id = $1",
      [comes.id],
    );
    const list = async (query: string): Promise<SkillPage> => {
      const response = await call("GET", `/v1/skills${query}`);
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as SkillPage;
    };
    const slugs = (page: SkillPage) =>
      page.items.map((item) => item.slug).sort();

    assertEquals(slugs(await list("?scope=organization")), [
      "shared-a",
      "shared-b",
    ]);
    assertEquals(slugs(await list("?scope=personal")), ["mine-a"]);
    assertEquals(slugs(await list("?scope=global")), ["from-bakery"]);
    assertEquals(
      (await list("")).items.length,
      4,
      "no filter lists every scope",
    );

    // A page of one is full of the asked scope, and the next page carries on.
    const first = await list("?scope=organization&limit=1");
    assertEquals(first.items.length, 1);
    assertEquals(first.items[0].scope, "organization");
    const second = await list(
      `?scope=organization&limit=1&cursor=${
        encodeURIComponent(first.nextCursor!)
      }`,
    );
    assertEquals(second.items.length, 1);
    assertEquals(second.items[0].scope, "organization");
    assertEquals(second.nextCursor, null);

    // The cursor belongs to the scope that issued it.
    const replayed = await call(
      "GET",
      `/v1/skills?scope=personal&limit=1&cursor=${
        encodeURIComponent(first.nextCursor!)
      }`,
    );
    assertEquals(replayed.status, 400, await replayed.clone().text());
    const unknown = await call("GET", "/v1/skills?scope=everyone");
    assertEquals(unknown.status, 400, await unknown.clone().text());
  } finally {
    await f.close();
  }
});
