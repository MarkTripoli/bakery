/* Vendor marks, one light and one dark file per provider. Static `*.svg`
   imports (the pattern of brand/logo-assets.ts) so the bundle holds exactly the
   files recorded in assets/provider-marks/README.md, with no remote request and
   so nothing that shifts while a mark loads. A provider with no entry here gets
   a letter tile; adding one needs the vendor's agreement first. */
import github_black from "../../../../assets/provider-marks/github/github-black.svg";
import github_white from "../../../../assets/provider-marks/github/github-white.svg";
import linear_dark from "../../../../assets/provider-marks/linear/linear-dark.svg";
import linear_light from "../../../../assets/provider-marks/linear/linear-light.svg";
import otel_color from "../../../../assets/provider-marks/opentelemetry/otel-color.svg";
import otel_white from "../../../../assets/provider-marks/opentelemetry/otel-white.svg";
import sentry_black from "../../../../assets/provider-marks/sentry/sentry-black.svg";
import sentry_white from "../../../../assets/provider-marks/sentry/sentry-white.svg";

/** The file shown on a light surface and the file shown on a dark one. */
export type ProviderMarkFiles = {
  readonly light: string;
  readonly dark: string;
};

/** The providers whose mark Bakery may show, keyed by the provider the server names. */
export const PROVIDER_MARKS: Readonly<Record<string, ProviderMarkFiles>> = {
  github: { light: github_black, dark: github_white },
  linear: { light: linear_dark, dark: linear_light },
  opentelemetry: { light: otel_color, dark: otel_white },
  sentry: { light: sentry_black, dark: sentry_white },
};
