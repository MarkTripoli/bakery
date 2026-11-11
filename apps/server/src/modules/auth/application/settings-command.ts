import {
  type InstallationSettingsUpdate,
  InstallationSettingsUpdateSchema,
} from "@bakery/contracts/installation-settings";

export type SettingsCommand = { operation: "get" } | {
  operation: "set";
  expectedVersion: number;
  input: InstallationSettingsUpdate;
};

export function parseSettingsCommand(args: readonly string[]): SettingsCommand {
  if (args.length === 1 && args[0] === "get") return { operation: "get" };
  if (args[0] !== "set") throw new Error("INSTALLATION_SETTINGS_USAGE_INVALID");
  const fields = new Map<string, string>();
  const names = new Set([
    "--registration-mode",
    "--organization-creation-policy",
    "--expected-version",
  ]);
  for (let index = 1; index < args.length; index++) {
    const [flag, inline] = args[index]!.split(/=(.*)/s, 2);
    if (!flag || !names.has(flag) || fields.has(flag)) {
      throw new Error("INSTALLATION_SETTINGS_USAGE_INVALID");
    }
    const value = inline ?? args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("INSTALLATION_SETTINGS_USAGE_INVALID");
    }
    fields.set(flag, value);
  }
  const expected = fields.get("--expected-version");
  if (
    !expected || !/^[1-9]\d*$/.test(expected) ||
    !Number.isSafeInteger(Number(expected))
  ) {
    throw new Error("INSTALLATION_SETTINGS_EXPECTED_VERSION_REQUIRED");
  }
  const parsed = InstallationSettingsUpdateSchema.safeParse({
    registrationMode: fields.get("--registration-mode"),
    organizationCreationPolicy: fields.get("--organization-creation-policy"),
  });
  if (!parsed.success) throw new Error("INSTALLATION_SETTINGS_POLICY_INVALID");
  return {
    operation: "set",
    expectedVersion: Number(expected),
    input: parsed.data,
  };
}
