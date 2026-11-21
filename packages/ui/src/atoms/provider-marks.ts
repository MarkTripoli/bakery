/* Vendor marks, one light and one dark file per provider. Static `*.svg`
   imports (the pattern of brand/logo-assets.ts) so the bundle holds exactly the
   files recorded in assets/provider-marks/README.md, with no remote request and
   so nothing that shifts while a mark loads. A provider with no entry here gets
   a letter tile; adding one needs the vendor's agreement first. */
import github_black from "../../../../assets/provider-marks/github/github-black.svg";
import github_white from "../../../../assets/provider-marks/github/github-white.svg";
import linear_dark from "../../../../assets/provider-marks/linear/linear-dark.svg";
import linear_light from "../../../../assets/provider-marks/linear/linear-light.svg";
import openai_black from "../../../../assets/provider-marks/openai/openai-black.svg";
import openai_white from "../../../../assets/provider-marks/openai/openai-white.svg";
import openrouter_cloud from "../../../../assets/provider-marks/openrouter/openrouter-cloud.svg";
import openrouter_ink from "../../../../assets/provider-marks/openrouter/openrouter-ink.svg";
import otel_color from "../../../../assets/provider-marks/opentelemetry/otel-color.svg";
import otel_white from "../../../../assets/provider-marks/opentelemetry/otel-white.svg";
import sentry_black from "../../../../assets/provider-marks/sentry/sentry-black.svg";
import sentry_white from "../../../../assets/provider-marks/sentry/sentry-white.svg";

/**
 * The file shown on a light surface and the file shown on a dark one. `crop`
 * shows the file through a smaller view box, for a vendor file that keeps its
 * own clear space: the file's bytes are never edited, only how much of it
 * shows, so the glyph fills the slot like every other mark. `clearSpace` is
 * the other answer for the same kind of file: the whole file is drawn at twice
 * the normal art size and overflows the slot, so its glyph reads at the normal
 * size and the file itself is neither cropped nor edited.
 */
export type ProviderMarkFiles = {
  readonly light: string;
  readonly dark: string;
  /** The file carries its own clear space: draw it whole at twice the art size, overflowing the slot. */
  readonly clearSpace?: true;
  readonly crop?: {
    readonly viewBox: string;
    readonly width: number;
    readonly height: number;
  };
};

/** The providers whose mark Bakery may show, keyed by the provider the server names. */
export const PROVIDER_MARKS: Readonly<Record<string, ProviderMarkFiles>> = {
  github: { light: github_black, dark: github_white },
  linear: { light: linear_dark, dark: linear_light },
  // The vendors' own monochrome files, uncropped. OpenAI's keeps wide clear
  // space, so it is drawn at twice the art size and overflows its slot.
  openai: { light: openai_black, dark: openai_white, clearSpace: true },
  openrouter: { light: openrouter_ink, dark: openrouter_cloud },
  opentelemetry: { light: otel_color, dark: otel_white },
  sentry: {
    light: sentry_black,
    dark: sentry_white,
    // The Sentry files keep the vendor's clear space around the glyph.
    crop: {
      viewBox: "58.58 58.56 148.81 132.57",
      width: 265.98,
      height: 249.68,
    },
  },
};

/** Whether Bakery may show this provider's mark; one without gets a letter tile. */
export function providerHasMark(provider: string): boolean {
  return Object.hasOwn(PROVIDER_MARKS, provider);
}
