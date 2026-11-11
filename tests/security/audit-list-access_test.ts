import { assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";

Deno.test("audit list actions refuse non-admins and anonymous callers", async () => {
  const f = await openInstallationFixture();
  try {
    const headers = orgHeader(f.organizationId);
    // Organization read denials answer 404 so a viewer cannot probe what exists.
    const developerOrganization = await call(
      f,
      "GET",
      "/v1/audit-events",
      f.developerCookie,
      { headers },
    );
    assertEquals(
      developerOrganization.status,
      404,
      await developerOrganization.clone().text(),
    );
    const developerInstallation = await call(
      f,
      "GET",
      "/v1/installation/audit-events",
      f.developerCookie,
    );
    assertEquals(
      developerInstallation.status,
      403,
      await developerInstallation.clone().text(),
    );
    for (const path of ["/v1/audit-events", "/v1/installation/audit-events"]) {
      const anonymous = await f.app.fetch(
        new Request(`http://127.0.0.1:8788${path}`, { headers }),
      );
      assertEquals(anonymous.status, 401, path);
    }
  } finally {
    await f.finish();
  }
});
