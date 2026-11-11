import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * Paper's `authShell` brand pane (`auth.js` L92) as `UI.AuthEntry` props:
 * the wordmark, the two-line tagline, the three "how Bakery works" steps and
 * the pane footer, plus the theme toggle that sits in `.form-bottom`.
 *
 * Every brand-variant auth screen renders the identical pane, so it lives
 * here rather than in each presenter — the artboards differ only in the form
 * column. Spread it: `<UI.AuthEntry variant="brand" {...useAuthBrandProps()}>`.
 */
export function useAuthBrandProps(): Pick<
  UI.AuthEntryProps,
  "tagline" | "steps" | "footer" | "themeToggle"
> {
  const { translate } = useI18n();
  return {
    // auth.js L92 `<h2>Fresh commits,<br>coming right up.</h2>`: the break is
    // part of the composition, not a consequence of the 330px measure.
    tagline: (
      <>
        {translate("auth.brand.tagline.line1")}
        <br />
        {translate("auth.brand.tagline.line2")}
      </>
    ),
    steps: [
      { icon: "idea", label: translate("auth.brand.steps.idea") },
      { icon: "activity", label: translate("auth.brand.steps.activity") },
      { icon: "batch", label: translate("auth.brand.steps.batch") },
    ],
    footer: translate("auth.brand.footer"),
    themeToggle: <UI.ThemeToggle label={translate("auth.theme.toggle")} />,
  };
}
