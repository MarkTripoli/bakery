import { useMemo } from "react";
import type { ImgHTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { qrPngDataUrl } from "./qr-raster.ts";
import "../data.css";

export type QrCodeProps =
  & Omit<SemanticNativeProps<ImgHTMLAttributes<HTMLImageElement>>, "src">
  & {
    /**
     * Row-major module matrix including its quiet zone, `true` = dark. The
     * caller encodes it (`apps/web`'s `totpQrModules`); this component only
     * draws it, so no encoder reaches the UI package.
     */
    modules: readonly (readonly boolean[])[];
    /** What the code enrols, for assistive technology. */
    label: string;
  };

/**
 * A QR code on a fixed light plate — Paper's `.totp-qr` (auth.css:22): a
 * 176x176 box with a 12px inset, a hairline border and a 4px radius, the
 * modules scaled to fit its 150x150 inner box. The plate deliberately
 * ignores the theme (`--color-qr-plate`): a camera needs dark modules on a
 * light field, and the design's artboards keep the same white plate in dark
 * mode.
 */
export function QrCode({ label, modules, ...props }: QrCodeProps) {
  const src = useMemo(() => qrPngDataUrl(modules), [modules]);
  return (
    <img
      alt={label}
      className="ui-qr-code"
      src={src}
      {...props}
      data-state="default"
      data-ui-component="qrCode"
      data-variant="default"
    />
  );
}
