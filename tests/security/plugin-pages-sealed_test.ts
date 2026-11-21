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
  secondOrganization,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";

/**
 * A plugin page is sealed (#76, FS24, AC1). The document is served under a
 * policy that gives it an opaque origin (no cookie, storage or same-origin
 * reach), closes the network and top navigation, and is only ever handed out
 * to a member of the install's own organization, for that install's own pages.
 */

const CHECKLIST = {
  id: "checklist",
  title: "Release checklist",
  file: "checklist.html",
};

function raw(
  fixture: Fixture,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, {
      method: "GET",
      headers: { Origin: fixture.config.publicBaseUrl, ...headers },
    }),
  ));
}

async function onePage(
  fixture: Fixture,
  store: Parameters<Parameters<typeof withPluginFixture>[0]>[1],
) {
  const published = await publishWithPages(
    fixture,
    store,
    pagesManifest([CHECKLIST]),
    { "checklist.html": CHECKLIST_HTML },
  );
  assertEquals(
    published.response.status,
    201,
    await published.response.clone().text(),
  );
  return { published, installId: await install(fixture, published) };
}

Deno.test("the document cannot reach the session: opaque origin, no cookie set, none without one", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId } = await onePage(fixture, store);
    const path =
      `/v1/plugin-installs/${installId}/pages/checklist/document?${RENDER}&organizationId=${fixture.organizationId}`;

    const served = await raw(fixture, path, { Cookie: fixture.adminCookie });
    assertEquals(served.status, 200, await served.clone().text());
    const csp = served.headers.get("Content-Security-Policy") ?? "";
    const directives = csp.split(";").map((part) => part.trim());
    // sandbox without allow-same-origin: the browser gives the document an
    // opaque origin, so document.cookie throws and storage is unavailable,
    // whether it is framed with or without a sandbox attribute or opened in a tab.
    assertEquals(directives[0], "sandbox allow-scripts");
    for (
      const forbidden of [
        "allow-same-origin",
        "allow-top-navigation",
        "allow-popups",
        "allow-forms",
        "allow-modals",
      ]
    ) {
      assert(!csp.includes(forbidden), forbidden);
    }
    assertEquals(served.headers.get("Set-Cookie"), null);
    assertEquals(served.headers.get("Referrer-Policy"), "no-referrer");
    // The bytes are the bundle's: nothing of the session is written into them.
    const body = await served.text();
    assertEquals(body, CHECKLIST_HTML);
    assert(!body.includes(fixture.adminCookie.split("=")[1] ?? "\u0000"));

    const anonymous = await raw(fixture, path, {});
    assertEquals(anonymous.status, 401, await anonymous.clone().text());
    assert(!(await anonymous.text()).includes("Release checklist"));
  }));

Deno.test("the document's policy blocks the network and every other origin", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId } = await onePage(fixture, store);
    const served = await call(
      fixture,
      `/v1/plugin-installs/${installId}/pages/checklist/document?${RENDER}`,
      { method: "GET" },
    );
    assertEquals(served.status, 200, await served.clone().text());
    const directives = new Map(
      (served.headers.get("Content-Security-Policy") ?? "").split(";").map(
        (part) => {
          const [name, ...values] = part.trim().split(/\s+/);
          return [name, values.join(" ")] as const;
        },
      ),
    );
    // default-src 'none' and no connect-src: fetch, XHR, WebSocket,
    // EventSource and beacons fall back to 'none'.
    assertEquals(directives.get("default-src"), "'none'");
    assert(!directives.has("connect-src"));
    assertEquals(directives.get("script-src"), "'unsafe-inline'");
    assertEquals(directives.get("form-action"), "'none'");
    assertEquals(directives.get("base-uri"), "'none'");
    assertEquals(directives.get("frame-ancestors"), "'self'");
    for (const [name, value] of directives) {
      // No directive names a scheme or host a request could leave by.
      assert(!/https?:|wss?:|\*/.test(value), `${name} ${value}`);
    }
    assertEquals(served.headers.get("X-Content-Type-Options"), "nosniff");
    assert(served.headers.get("Permissions-Policy")?.includes("camera=()"));
  }));

Deno.test("another tenant's context cannot read an install's page", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId } = await onePage(fixture, store);
    const other = await secondOrganization(fixture);
    const pagePath = `/v1/plugin-installs/${installId}/pages/checklist`;

    // The admin is a real member of the second organization, so only the
    // tenant predicate keeps the install out of reach.
    const access = await raw(fixture, pagePath, {
      Cookie: fixture.adminCookie,
      "Bakery-Organization-Id": other.organizationId,
    });
    assertEquals(access.status, 200, await access.clone().text());
    const body = await access.json();
    assertEquals(
      [body.status, body.reason, body.title, body.pluginDisplayName],
      ["refused", "removed", null, null],
    );

    const viaQuery = await raw(
      fixture,
      `${pagePath}/document?${RENDER}&organizationId=${other.organizationId}`,
      { Cookie: fixture.adminCookie },
    );
    assertEquals(viaQuery.status, 404, await viaQuery.clone().text());

    // A header and a query that disagree are refused rather than reconciled.
    const mixed = await raw(
      fixture,
      `${pagePath}/document?${RENDER}&organizationId=${other.organizationId}`,
      {
        Cookie: fixture.adminCookie,
        "Bakery-Organization-Id": fixture.organizationId,
      },
    );
    assert(mixed.status >= 400 && mixed.status < 500, String(mixed.status));
    assert(!(await mixed.text()).includes("Release checklist"));

    const sidebar = await raw(fixture, "/v1/plugin-pages", {
      Cookie: fixture.adminCookie,
      "Bakery-Organization-Id": other.organizationId,
    });
    assertEquals(sidebar.status, 200, await sidebar.clone().text());
    assertEquals((await sidebar.json()).items, []);
  }));

Deno.test("a non-member naming an organization in the query is refused", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId } = await onePage(fixture, store);
    const other = await secondOrganization(fixture);
    const colleague = await inviteColleague(fixture, "developer");
    const refused = await raw(
      fixture,
      `/v1/plugin-installs/${installId}/pages/checklist/document?${RENDER}&organizationId=${other.organizationId}`,
      { Cookie: colleague },
    );
    assert(
      refused.status === 403 || refused.status === 404,
      String(refused.status),
    );
    assert(!(await refused.text()).includes("Release checklist"));
    // The same colleague, in their own organization, does get the page.
    const allowed = await asCookie(fixture, colleague)(
      `/v1/plugin-installs/${installId}/pages/checklist/document?${RENDER}`,
      { method: "GET" },
    );
    assertEquals(allowed.status, 200, await allowed.clone().text());
  }));

Deno.test("one plugin's install never serves another plugin's page", () =>
  withPluginFixture(async (fixture, store) => {
    const { installId } = await onePage(fixture, store);
    const SECRET = "<p>other plugin's secret page</p>";
    const other = await publishWithPages(
      fixture,
      store,
      pagesManifest([{ id: "secret", title: "Secret", file: "secret.html" }]),
      { "secret.html": SECRET },
    );
    const otherInstall = await install(fixture, other);

    const crossed = await call(
      fixture,
      `/v1/plugin-installs/${installId}/pages/secret/document?${RENDER}`,
      { method: "GET" },
    );
    assertEquals(crossed.status, 404, await crossed.clone().text());
    assert(!(await crossed.text()).includes("secret page"));
    const own = await call(
      fixture,
      `/v1/plugin-installs/${otherInstall}/pages/secret/document?${RENDER}`,
      { method: "GET" },
    );
    assertEquals(await own.text(), SECRET);
  }));
