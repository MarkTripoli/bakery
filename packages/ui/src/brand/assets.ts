/* Typed brand asset map. `logo()` and `scene()` are declared in their own
   modules so each pulls only its art; import `logo-assets.ts` directly when
   scenes are not needed. */
export { logo, type LogoAsset } from "./logo-assets.ts";
export { scene, type SceneAsset } from "./scene-assets.ts";
export type {
  LogoArt,
  LogoRequest,
  LogoSurfaceId,
  LogoTileVariantId,
  LogoVariantId,
} from "./logo-select.ts";
export type { SceneId, SceneOptions, SceneTheme } from "./scene-select.ts";
