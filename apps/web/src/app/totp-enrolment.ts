import { create } from "qrcode/lib/core/qrcode.js";

/**
 * The design's QR raster (`docs/technical-design/auth-mocks/totp-demo.png`)
 * surrounds the symbol with exactly one light module, which is what a
 * scanner needs to find the finder patterns inside a bordered plate.
 */
const QUIET_ZONE_MODULES = 1;

/** Characters per group in the hand-typed setup key (`auth.js` L109). */
const SETUP_KEY_GROUP = 4;

/**
 * Encodes an enrolment's `otpauth://` URI as a QR module matrix for
 * `UI.QrCode`, quiet zone included, row-major, `true` = dark.
 *
 * The error-correction level is Paper's: `M` with an automatically chosen
 * version reproduces the committed `totp-demo.png` module for module
 * (version 7, 45 modules, mask 5) for the design's demo URI, which is what
 * the parity gate compares against.
 */
export function totpQrModules(
  totpUri: string,
): readonly (readonly boolean[])[] {
  const { modules } = create(totpUri, { errorCorrectionLevel: "M" });
  const symbol = modules.size;
  const size = symbol + QUIET_ZONE_MODULES * 2;
  const rows: boolean[][] = new Array(size);
  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = new Array(size).fill(false);
    const symbolRow = row - QUIET_ZONE_MODULES;
    if (symbolRow >= 0 && symbolRow < symbol) {
      const offset = symbolRow * symbol;
      for (let column = 0; column < symbol; column += 1) {
        cells[column + QUIET_ZONE_MODULES] = modules.data[offset + column] ===
          1;
      }
    }
    rows[row] = cells;
  }
  return rows;
}

/**
 * The shared secret an authenticator can be fed by hand, grouped in fours
 * the way the artboard prints it ("JBSW Y3DP EHPK 3PXP"). An enrolment URI
 * the provider did not shape as expected yields an empty key, and the screen
 * simply shows an empty plate rather than failing the whole enrolment.
 */
export function totpSetupKey(totpUri: string): string {
  let secret: string;
  try {
    secret = new URL(totpUri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
  const groups: string[] = [];
  for (let at = 0; at < secret.length; at += SETUP_KEY_GROUP) {
    groups.push(secret.slice(at, at + SETUP_KEY_GROUP));
  }
  return groups.join(" ");
}
