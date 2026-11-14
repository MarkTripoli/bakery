import type { JSX } from "react";
import { SettingsIndexScreen } from "../../screens/SettingsIndexScreen.tsx";

/**
 * Paper O-0 phone Settings index sample (frame QM9-0): the real presenter with
 * inert navigation and the mock's six rows, including the two whose counts
 * production has no source for.
 */
export const sectionIndexSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: () => (
    <SettingsIndexScreen
      displayName="Alex Morgan"
      email="alex.morgan@example.com"
      items={[
        {
          id: "profile",
          href: "#profile",
          title: "Profile",
          description: "Name, job title and photo",
        },
        {
          id: "security",
          href: "#security",
          title: "Account & security",
          description: "Password, email, and sign-in methods",
        },
        {
          id: "sessions",
          href: "#sessions",
          title: "Active sessions",
          description: "3 signed-in devices",
        },
        {
          id: "clients",
          href: "#clients",
          title: "Connected clients",
          description: "1 authorized app",
        },
        {
          id: "appearance",
          href: "#appearance",
          title: "Appearance",
          description: "Theme, language and time zone",
        },
        {
          id: "access",
          href: "#access",
          title: "Your access",
          description: "Your role and effective permissions",
        },
      ]}
      onNavigate={(event) => event.preventDefault()}
      onSignOut={() => {}}
    />
  ),
};
