import type { JSX } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type OrganizationChoice,
  OrganizationsScreen,
} from "../../screens/OrganizationsScreen.tsx";

function Specimen(
  { state }: { readonly state: "ready" | "empty" | "removed" },
) {
  const { translate } = useI18n();
  // The two illustrative memberships the Paper artboard shows; the role hint
  // is catalog copy, as the page supplies it.
  const organizations: readonly OrganizationChoice[] = [
    {
      id: "northstar",
      initial: "N",
      name: "Northstar",
      role: translate("auth.invitation.role.Developer"),
    },
    {
      id: "personal",
      initial: "P",
      name: "Personal",
      role: translate("auth.invitation.role.Admin"),
    },
  ];
  return (
    <OrganizationsScreen
      forbidden={false}
      loadMore={null}
      onLoadMore={() => {}}
      onRefresh={() => {}}
      onSelect={() => {}}
      organizations={state === "ready" ? organizations : []}
      state={state}
    />
  );
}

function specimen(state: "ready" | "empty" | "removed") {
  return () => <Specimen state={state} />;
}

/**
 * Paper `organizations` — the chooser (`default`), no membership at all
 * (`empty`), and the membership that went away (`removed`).
 */
export const organizationsSpecimens: Readonly<
  Record<string, () => JSX.Element>
> = {
  default: specimen("ready"),
  empty: specimen("empty"),
  removed: specimen("removed"),
};
