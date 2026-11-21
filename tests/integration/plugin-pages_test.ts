import { assert, assertEquals } from "@std/assert";
import {
  asCookie,
  call,
  CHECKLIST_HTML,
  type Fixture,
  install,
  inviteColleague,
  pagesManifest,
  publishWithPages,
  RENDER,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import { PLUGIN_PAGE_LIMITS } from "@bakery/contracts/plugin-sdk";

/**
 * A plugin's own pages end to end (#76, FS24): versions name pages, one page's
 * access and document are read through the real routes, and the sidebar list
 * pages by cursor. Refusals are asserted by their typed reason.
 */

const CHECKLIST = {
  id: "checklist",
  title: "Release checklist",
  file: "pages/checklist.html",
};
const NOTES = { id: "notes", title: "Release notes", file: "notes.html" };
const FILES = {
  "pages/checklist.html": CHECKLIST_HTML,
  "notes.html": "<p>notes</p>",
};

async function access(fixture: Fixture, installId: string, pageId: string) {
  const response = await call(
    fixture,
    `/v1/plugin-installs/${installId}/pages/${pageId}`,
    { method: "GET" },
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

function documentRead(fixture: Fixture, installId: string, pageId: string) {
  return call(
    fixture,
    `/v1/plugin-installs/${installId}/pages/${pageId}/document?${RENDER}`,
    { method: "GET" },
  );
}

Deno.test("a version names its pages, and one missing from the bundle is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishWithPages(
      fixture,
      store,
      pagesManifest([CHECKLIST, NOTES]),
      FILES,
    );
    assertEquals(
      published.response.status,
      201,
      await published.response.clone().text(),
    );
    assertEquals((await published.response.json()).pages, [CHECKLIST, NOTES]);

    const missing = await publishWithPages(
      fixture,
      store,
      pagesManifest([{ ...NOTES, file: "absent.html" }]),
      FILES,
    );
    assertEquals(
      missing.response.status,
      422,
      await missing.response.clone().text(),
    );
    const traversal = await publishWithPages(
      fixture,
      store,
      pagesManifest([{ ...NOTES, file: "../notes.html" }]),
      FILES,
    );
    assertEquals(
      traversal.response.status,
      422,
      await traversal.response.clone().text(),
    );
  }));

Deno.test("an available page serves its own bytes, sealed, with the render inputs", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishWithPages(
      fixture,
      store,
      pagesManifest([CHECKLIST]),
      FILES,
    );
    const installId = await install(fixture, published);
    const read = await access(fixture, installId, "checklist");
    assertEquals(read.status, "available");
    assertEquals(read.reason, null);
    assertEquals(read.title, "Release checklist");
    assertEquals(read.pluginDisplayName, "Release helper");
    assertEquals(
      read.documentPath,
      `/v1/plugin-installs/${installId}/pages/checklist/document`,
    );

    const document = await documentRead(fixture, installId, "checklist");
    assertEquals(document.status, 200, await document.clone().text());
    assertEquals(await document.text(), CHECKLIST_HTML);
    assert(
      document.headers.get("Content-Security-Policy")?.startsWith(
        "sandbox allow-scripts",
      ),
    );
    assertEquals(document.headers.get("Content-Language"), "ar-EG");

    // Theme, locale and direction are part of the contract: without them the
    // host would show a light page in a dark Bakery.
    const bare = await call(
      fixture,
      `/v1/plugin-installs/${installId}/pages/checklist/document`,
      { method: "GET" },
    );
    assertEquals(bare.status, 400, await bare.clone().text());
  }));

Deno.test("each refusal has its typed reason", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishWithPages(
      fixture,
      store,
      pagesManifest([CHECKLIST]),
      FILES,
    );
    const installId = await install(fixture, published);

    const noSuchPage = await access(fixture, installId, "nope");
    assertEquals([noSuchPage.status, noSuchPage.reason], [
      "refused",
      "no_such_page",
    ]);
    assertEquals(noSuchPage.documentPath, null);
    assertEquals((await documentRead(fixture, installId, "nope")).status, 404);

    // A grant taken away outside the lifecycle (as a future revocation would).
    await fixture.pgDatabase.query(
      `delete from bakery.plugin_install_grants
        where organization_id = $1 and plugin_install_id = $2 and capability = 'ui.page'`,
      [fixture.organizationId, installId],
    );
    const notGranted = await access(fixture, installId, "checklist");
    assertEquals(notGranted.reason, "not_granted");
    assertEquals(
      (await documentRead(fixture, installId, "checklist")).status,
      403,
    );

    const off = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(off.status, 200, await off.clone().text());
    const offRead = await access(fixture, installId, "checklist");
    assertEquals(offRead.reason, "off");
    assertEquals(offRead.title, "Release checklist");
    assertEquals(
      (await documentRead(fixture, installId, "checklist")).status,
      409,
    );

    const removed = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "uninstalled" },
    });
    assertEquals(removed.status, 200, await removed.clone().text());
    assertEquals(
      (await access(fixture, installId, "checklist")).reason,
      "removed",
    );
    assertEquals(
      (await access(fixture, crypto.randomUUID(), "checklist")).reason,
      "removed",
    );
  }));

Deno.test("another person's private page is no_access, and is not in my sidebar", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishWithPages(
      fixture,
      store,
      pagesManifest([CHECKLIST]),
      FILES,
    );
    const colleague = asCookie(
      fixture,
      await inviteColleague(fixture, "developer"),
    );
    const theirs = await install(fixture, published, "personal", colleague);

    const read = await access(fixture, theirs, "checklist");
    assertEquals([read.status, read.reason], ["refused", "no_access"]);
    assertEquals(read.pluginDisplayName, null);
    assertEquals(
      (await documentRead(fixture, theirs, "checklist")).status,
      404,
    );

    const mine =
      await (await call(fixture, "/v1/plugin-pages", { method: "GET" })).json();
    assertEquals(
      mine.items.filter((item: { installId: string }) =>
        item.installId === theirs
      ),
      [],
    );
    const own = await (await colleague("/v1/plugin-pages", { method: "GET" }))
      .json();
    assertEquals(
      own.items.map((
        item: { installId: string; pageId: string },
      ) => [item.installId, item.pageId]),
      [[theirs, "checklist"]],
    );
    assertEquals(own.items[0].scope, "personal");
  }));

Deno.test("the sidebar list pages by cursor over every page without repeats", () =>
  withPluginFixture(async (fixture, store) => {
    const first = await publishWithPages(
      fixture,
      store,
      pagesManifest([CHECKLIST, NOTES]),
      FILES,
    );
    const second = await publishWithPages(
      fixture,
      store,
      pagesManifest([NOTES]),
      FILES,
    );
    const third = await publishWithPages(
      fixture,
      store,
      pagesManifest([CHECKLIST]),
      FILES,
    );
    const a = await install(fixture, first);
    const b = await install(fixture, second);
    const c = await install(fixture, third);
    // Off pages are not listed.
    await call(fixture, `/v1/plugin-installs/${c}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : "?limit=1";
      const response = await call(fixture, `/v1/plugin-pages${query}`, {
        method: "GET",
      });
      assertEquals(response.status, 200, await response.clone().text());
      const body = await response.json();
      assert(body.items.length <= 1);
      for (const item of body.items) {
        seen.push(`${item.installId}/${item.pageId}`);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    assertEquals(seen, [`${a}/checklist`, `${a}/notes`, `${b}/notes`]);
  }));

Deno.test("a page file at the size limit publishes, and one byte over is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const page = { id: "big", title: "Big page", file: "big.html" };
    const html = (bytes: number) => {
      const head = "<!doctype html><p>";
      return head + "a".repeat(bytes - head.length);
    };
    const atLimit = await publishWithPages(
      fixture,
      store,
      pagesManifest([page]),
      { "big.html": html(PLUGIN_PAGE_LIMITS.documentMaxBytes) },
    );
    assertEquals(
      atLimit.response.status,
      201,
      await atLimit.response.clone().text(),
    );
    const over = await publishWithPages(
      fixture,
      store,
      pagesManifest([page]),
      { "big.html": html(PLUGIN_PAGE_LIMITS.documentMaxBytes + 1) },
      atLimit.packageId,
    );
    const body = await over.response.text();
    assertEquals(over.response.status, 422, body);
    assert(body.includes("VALIDATION_FAILED"), body);
  }));
