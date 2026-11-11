/* Logo URL binding. Static `*.svg` imports (pattern of atoms/LogoMark.tsx) so
   Vite and Storybook bundle exactly the logo art; scenes live in
   `scene-assets.ts` and the selection tables in `logo-select.ts` /
   `scene-select.ts`, so a consumer of the mark or lockup does not pull every
   scene or both full JSON contracts into its bundle. `brand-assets.node.mjs`
   asserts this table holds every file `logo-select.ts` can return. */
import logo_lockup_lockup_color_dark from "../../../../assets/brand/logo/lockup/lockup-color-dark.svg";
import logo_lockup_lockup_color_light from "../../../../assets/brand/logo/lockup/lockup-color-light.svg";
import logo_lockup_lockup_mono_dark from "../../../../assets/brand/logo/lockup/lockup-mono-dark.svg";
import logo_lockup_lockup_mono_light from "../../../../assets/brand/logo/lockup/lockup-mono-light.svg";
import logo_lockup_lockup_on_brand from "../../../../assets/brand/logo/lockup/lockup-on-brand.svg";
import logo_mark_mark_16_color_dark from "../../../../assets/brand/logo/mark/mark-16-color-dark.svg";
import logo_mark_mark_16_color_light from "../../../../assets/brand/logo/mark/mark-16-color-light.svg";
import logo_mark_mark_16_mono_dark from "../../../../assets/brand/logo/mark/mark-16-mono-dark.svg";
import logo_mark_mark_16_mono_light from "../../../../assets/brand/logo/mark/mark-16-mono-light.svg";
import logo_mark_mark_16_on_brand from "../../../../assets/brand/logo/mark/mark-16-on-brand.svg";
import logo_mark_mark_16_tile_dark from "../../../../assets/brand/logo/mark/mark-16-tile-dark.svg";
import logo_mark_mark_16_tile_light from "../../../../assets/brand/logo/mark/mark-16-tile-light.svg";
import logo_mark_mark_32_color_dark from "../../../../assets/brand/logo/mark/mark-32-color-dark.svg";
import logo_mark_mark_32_color_light from "../../../../assets/brand/logo/mark/mark-32-color-light.svg";
import logo_mark_mark_32_mono_dark from "../../../../assets/brand/logo/mark/mark-32-mono-dark.svg";
import logo_mark_mark_32_mono_light from "../../../../assets/brand/logo/mark/mark-32-mono-light.svg";
import logo_mark_mark_32_on_brand from "../../../../assets/brand/logo/mark/mark-32-on-brand.svg";
import logo_mark_mark_32_tile_dark from "../../../../assets/brand/logo/mark/mark-32-tile-dark.svg";
import logo_mark_mark_32_tile_light from "../../../../assets/brand/logo/mark/mark-32-tile-light.svg";
import logo_mark_mark_color_dark from "../../../../assets/brand/logo/mark/mark-color-dark.svg";
import logo_mark_mark_color_light from "../../../../assets/brand/logo/mark/mark-color-light.svg";
import logo_mark_mark_mono_dark from "../../../../assets/brand/logo/mark/mark-mono-dark.svg";
import logo_mark_mark_mono_light from "../../../../assets/brand/logo/mark/mark-mono-light.svg";
import logo_mark_mark_on_brand from "../../../../assets/brand/logo/mark/mark-on-brand.svg";
import logo_mark_mark_tile_dark from "../../../../assets/brand/logo/mark/mark-tile-dark.svg";
import logo_mark_mark_tile_light from "../../../../assets/brand/logo/mark/mark-tile-light.svg";
import logo_wordmark_wordmark_color_dark from "../../../../assets/brand/logo/wordmark/wordmark-color-dark.svg";
import logo_wordmark_wordmark_color_light from "../../../../assets/brand/logo/wordmark/wordmark-color-light.svg";
import logo_wordmark_wordmark_mono_dark from "../../../../assets/brand/logo/wordmark/wordmark-mono-dark.svg";
import logo_wordmark_wordmark_mono_light from "../../../../assets/brand/logo/wordmark/wordmark-mono-light.svg";
import {
  type LogoRequest,
  type LogoSelection,
  selectLogo,
} from "./logo-select.ts";

export type {
  LogoArt,
  LogoRequest,
  LogoSelection,
  LogoSurfaceId,
  LogoTileVariantId,
  LogoVariantId,
} from "./logo-select.ts";

const urls: Record<string, string> = {
  "assets/brand/logo/lockup/lockup-color-dark.svg":
    logo_lockup_lockup_color_dark,
  "assets/brand/logo/lockup/lockup-color-light.svg":
    logo_lockup_lockup_color_light,
  "assets/brand/logo/lockup/lockup-mono-dark.svg": logo_lockup_lockup_mono_dark,
  "assets/brand/logo/lockup/lockup-mono-light.svg":
    logo_lockup_lockup_mono_light,
  "assets/brand/logo/lockup/lockup-on-brand.svg": logo_lockup_lockup_on_brand,
  "assets/brand/logo/mark/mark-16-color-dark.svg": logo_mark_mark_16_color_dark,
  "assets/brand/logo/mark/mark-16-color-light.svg":
    logo_mark_mark_16_color_light,
  "assets/brand/logo/mark/mark-16-mono-dark.svg": logo_mark_mark_16_mono_dark,
  "assets/brand/logo/mark/mark-16-mono-light.svg": logo_mark_mark_16_mono_light,
  "assets/brand/logo/mark/mark-16-on-brand.svg": logo_mark_mark_16_on_brand,
  "assets/brand/logo/mark/mark-16-tile-dark.svg": logo_mark_mark_16_tile_dark,
  "assets/brand/logo/mark/mark-16-tile-light.svg": logo_mark_mark_16_tile_light,
  "assets/brand/logo/mark/mark-32-color-dark.svg": logo_mark_mark_32_color_dark,
  "assets/brand/logo/mark/mark-32-color-light.svg":
    logo_mark_mark_32_color_light,
  "assets/brand/logo/mark/mark-32-mono-dark.svg": logo_mark_mark_32_mono_dark,
  "assets/brand/logo/mark/mark-32-mono-light.svg": logo_mark_mark_32_mono_light,
  "assets/brand/logo/mark/mark-32-on-brand.svg": logo_mark_mark_32_on_brand,
  "assets/brand/logo/mark/mark-32-tile-dark.svg": logo_mark_mark_32_tile_dark,
  "assets/brand/logo/mark/mark-32-tile-light.svg": logo_mark_mark_32_tile_light,
  "assets/brand/logo/mark/mark-color-dark.svg": logo_mark_mark_color_dark,
  "assets/brand/logo/mark/mark-color-light.svg": logo_mark_mark_color_light,
  "assets/brand/logo/mark/mark-mono-dark.svg": logo_mark_mark_mono_dark,
  "assets/brand/logo/mark/mark-mono-light.svg": logo_mark_mark_mono_light,
  "assets/brand/logo/mark/mark-on-brand.svg": logo_mark_mark_on_brand,
  "assets/brand/logo/mark/mark-tile-dark.svg": logo_mark_mark_tile_dark,
  "assets/brand/logo/mark/mark-tile-light.svg": logo_mark_mark_tile_light,
  "assets/brand/logo/wordmark/wordmark-color-dark.svg":
    logo_wordmark_wordmark_color_dark,
  "assets/brand/logo/wordmark/wordmark-color-light.svg":
    logo_wordmark_wordmark_color_light,
  "assets/brand/logo/wordmark/wordmark-mono-dark.svg":
    logo_wordmark_wordmark_mono_dark,
  "assets/brand/logo/wordmark/wordmark-mono-light.svg":
    logo_wordmark_wordmark_mono_light,
};

export type LogoAsset = Omit<LogoSelection, "file"> & { src: string };

/** Typed logo lookup: variant, else the surface's recommended variant, else
    `color-light`. Tiles only exist as marks; other pairs throw. */
export function logo(request: LogoRequest): LogoAsset {
  const { file, ...rest } = selectLogo(request);
  const src = urls[file];
  if (src === undefined) throw new Error(`logo: no bundled URL for ${file}`);
  return { src, ...rest };
}
