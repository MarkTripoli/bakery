import { assertEquals, assertThrows } from "@std/assert";
import {
  InstallationCapabilitiesSchema,
  type InstallationSettings,
  InstallationSettingsSchema,
  InstallationSettingsUpdateSchema,
  OrganizationCreationPolicy,
  RegistrationMode,
} from "@bakery/contracts/installation-settings";
import { createInstallationSettingsReader } from "../../apps/server/src/modules/auth/application/installation-settings.ts";

Deno.test("installation policy accepts only the declared registration modes", () => {
  for (const registrationMode of Object.values(RegistrationMode)) {
    assertEquals(
      InstallationSettingsUpdateSchema.parse({
        registrationMode,
        organizationCreationPolicy:
          OrganizationCreationPolicy.InstallationAdministrators,
      }).registrationMode,
      registrationMode,
    );
  }
  assertThrows(() =>
    InstallationSettingsUpdateSchema.parse({
      registrationMode: "open",
      organizationCreationPolicy: OrganizationCreationPolicy.AnyUser,
    })
  );
});

Deno.test("installation settings reject secret, authority and invalid revision fields", () => {
  const record = {
    registrationMode: RegistrationMode.Invitation,
    organizationCreationPolicy:
      OrganizationCreationPolicy.InstallationAdministrators,
    version: 1,
    updatedByPrincipalId: null,
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
  assertEquals(InstallationSettingsSchema.parse(record), record);
  for (const version of [0, -1, 1.5]) {
    assertThrows(() =>
      InstallationSettingsSchema.parse({ ...record, version })
    );
  }
  for (
    const extra of [{ unknownField: "secret" }, {
      installationAdministrator: true,
    }]
  ) {
    assertThrows(() =>
      InstallationSettingsSchema.parse({ ...record, ...extra })
    );
  }
});

Deno.test("public installation capabilities carry no private data", () => {
  const capabilities = {
    registration: RegistrationMode.Invitation,
    organizationCreation: OrganizationCreationPolicy.AnyUser,
    ssoAvailable: false,
  };
  assertEquals(
    InstallationCapabilitiesSchema.parse(capabilities),
    capabilities,
  );
  assertThrows(() =>
    InstallationCapabilitiesSchema.parse({
      ...capabilities,
      unknownField: "secret",
    })
  );
});

Deno.test("separate settings readers see a live policy change on the next read", async () => {
  const stored: InstallationSettings = {
    registrationMode: RegistrationMode.Invitation,
    organizationCreationPolicy:
      OrganizationCreationPolicy.InstallationAdministrators,
    version: 1,
    updatedByPrincipalId: null,
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
  let reads = 0;
  const load = () => {
    reads += 1;
    return Promise.resolve({ ...stored });
  };
  const first = createInstallationSettingsReader(load);
  const second = createInstallationSettingsReader(load);
  const prior = await first.current();
  stored.registrationMode = RegistrationMode.Closed;
  stored.version += 1;
  assertEquals(
    (await first.current()).registrationMode,
    RegistrationMode.Closed,
  );
  assertEquals(
    (await second.current()).registrationMode,
    RegistrationMode.Closed,
  );
  assertEquals(prior.registrationMode, RegistrationMode.Invitation);
  assertEquals(reads, 3);
});

Deno.test("settings reader fails closed on unavailable or invalid storage", async () => {
  for (
    const load of [
      () => Promise.reject(new Error("storage unavailable")),
      () => Promise.resolve(null),
      () => Promise.resolve({ registrationMode: "open" }),
    ]
  ) {
    let failed = false;
    try {
      await createInstallationSettingsReader(load).current();
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
  }
});
