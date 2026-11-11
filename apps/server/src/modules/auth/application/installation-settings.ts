import {
  type InstallationSettings,
  InstallationSettingsSchema,
} from "@bakery/contracts/installation-settings";

export interface InstallationSettingsReader {
  current(): Promise<InstallationSettings>;
}

export function createInstallationSettingsReader(
  load: () => Promise<unknown>,
): InstallationSettingsReader {
  return {
    async current() {
      return InstallationSettingsSchema.parse(await load());
    },
  };
}
