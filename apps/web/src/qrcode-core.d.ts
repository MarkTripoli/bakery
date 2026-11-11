/**
 * `qrcode`'s pure encoder core. The package's own entry point drags in a
 * canvas/PNG renderer (and, through it, `pngjs`/`yargs`) that the app never
 * needs: the only thing the product wants is the module matrix, which
 * `UI.QrCode` draws itself. The package ships no `exports` map, so this deep
 * path is a supported import; `@types/qrcode` types the renderer instead of
 * the core, so the one function used is declared here.
 */
declare module "qrcode/lib/core/qrcode.js" {
  export function create(
    data: string,
    options?: {
      errorCorrectionLevel?: "L" | "M" | "Q" | "H";
      version?: number;
      maskPattern?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
    },
  ): {
    readonly modules: { readonly size: number; readonly data: Uint8Array };
    readonly version: number;
    readonly maskPattern: number;
  };
}
