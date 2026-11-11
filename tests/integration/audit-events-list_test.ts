import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
  updateSettings,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";
import { readSettings } from "../helpers/installation-settings.ts";

type AuditPage = {
  items: {
    id: string;
    organizationId: string | null;
    operation: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
};

Deno.test("organization and installation audit lists are scoped, newest first and cursor-paged", async () => {
  const f = await openInstallationFixture();
  try {
    const settings = await readSettings(f);
    const policy = {
      registrationMode: "invitation",
      organizationCreationPolicy: "installation_admins",
    } as const;
    for (let step = 0; step < 2; step++) {
      const current = await readSettings(f);
      const response = await updateSettings(f, current.version, policy);
      assertEquals(response.status, 200, await response.clone().text());
    }
    assert(settings.version >= 1);
    const headers = orgHeader(f.organizationId);

    const organizationPage = async (query = "", cookie = f.adminCookie) =>
      await call(f, "GET", `/v1/audit-events${query}`, cookie, { headers });
    const first = await organizationPage("?limit=1");
    assertEquals(first.status, 200, await first.clone().text());
    const firstPage = await first.json() as AuditPage;
    assertEquals(firstPage.items.length, 1);
    assert(firstPage.nextCursor !== null);
    for (const item of firstPage.items) {
      assertEquals(item.organizationId, f.organizationId);
    }

    const second = await organizationPage(
      `?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    assertEquals(second.status, 200, await second.clone().text());
    const secondPage = await second.json() as AuditPage;
    const seen = new Set(firstPage.items.map((item) => item.id));
    for (const item of secondPage.items) assert(!seen.has(item.id));

    const mismatched = await organizationPage(
      `?limit=1&operation=organizations.create&cursor=${
        encodeURIComponent(firstPage.nextCursor!)
      }`,
    );
    assertEquals(mismatched.status, 400);
    assertEquals((await mismatched.json()).code, "INVALID_CURSOR");

    const filtered = await organizationPage(
      "?operation=organizationInvitations.create",
    );
    const filteredPage = await filtered.json() as AuditPage;
    assert(filteredPage.items.length > 0);
    for (const item of filteredPage.items) {
      assertEquals(item.operation, "organizationInvitations.create");
    }

    const installation = await call(
      f,
      "GET",
      "/v1/installation/audit-events?operation=installationSettings.update",
      f.adminCookie,
    );
    assertEquals(installation.status, 200, await installation.clone().text());
    const installationPage = await installation.json() as AuditPage;
    assert(installationPage.items.length >= 2);
    for (const item of installationPage.items) {
      assertEquals(item.organizationId, null);
    }
    const noOrganizationRows = await call(
      f,
      "GET",
      "/v1/installation/audit-events?operation=organizationInvitations.create",
      f.adminCookie,
    );
    assertEquals(
      (await noOrganizationRows.json() as AuditPage).items.length,
      0,
    );
  } finally {
    await f.finish();
  }
});
