import { assertEquals, assertThrows } from "@std/assert";
import { parseSettingsCommand } from "../../apps/server/src/modules/auth/application/settings-command.ts";

Deno.test("owner settings command parses both explicit policy fields and a CAS version", () => {
  assertEquals(parseSettingsCommand(["get"]), { operation: "get" });
  assertEquals(
    parseSettingsCommand([
      "set",
      "--registration-mode=closed",
      "--organization-creation-policy",
      "any_user",
      "--expected-version=2",
    ]),
    {
      operation: "set",
      expectedVersion: 2,
      input: {
        registrationMode: "closed",
        organizationCreationPolicy: "any_user",
      },
    },
  );
});

Deno.test("owner settings command rejects missing CAS, unsupported policy and ambiguous arguments", () => {
  const valid = [
    "set",
    "--registration-mode",
    "invitation",
    "--organization-creation-policy",
    "installation_admins",
    "--expected-version",
    "1",
  ];
  for (
    const args of [
      [],
      ["get", "unexpected"],
      valid.slice(0, 5),
      [...valid.slice(0, -1), "0"],
      [...valid.slice(0, -1), "1.5"],
      [...valid.slice(0, -1), "9007199254740992"],
      [...valid, "--expected-version", "2"],
      [...valid, "--unknown-flag", "secret"],
      [
        "set",
        "--registration-mode",
        "open",
        "--organization-creation-policy",
        "any_user",
        "--expected-version",
        "1",
      ],
    ]
  ) assertThrows(() => parseSettingsCommand(args));
});
