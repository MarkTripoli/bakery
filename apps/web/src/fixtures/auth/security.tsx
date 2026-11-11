import type { JSX } from "react";
import { AccountSettingsScreen } from "../../screens/AccountSettingsScreen.tsx";

const IDENTITY = {
  displayName: "Alex Morgan",
  email: "alex@example.com",
} as const;

export const securitySpecimens: Readonly<Record<string, () => JSX.Element>> = {
  default: () => (
    <AccountSettingsScreen
      {...IDENTITY}
      backupCodesRemaining={0}
      confirmed={false}
      twoFactorEnabled={false}
    />
  ),
  saved: () => (
    <AccountSettingsScreen
      {...IDENTITY}
      backupCodesRemaining={0}
      confirmed
      twoFactorEnabled={false}
    />
  ),
  protected: () => (
    <AccountSettingsScreen
      {...IDENTITY}
      backupCodesRemaining={8}
      confirmed={false}
      twoFactorEnabled
    />
  ),
};
