import type { Meta, StoryObj } from "@storybook/react-vite";
import { QrCode } from "@bakery/ui";
import { designQrModules } from "../examples/qr-design-matrix.ts";

const meta = {
  title: "Bakery/Molecules/QrCode",
  parameters: { catalogId: "ui.qrCode", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * Paper's `.totp-qr` plate is a fixed 176px square (auth.css:22) — a QR
 * symbol cannot reflow and stay scannable — so below the design's narrowest
 * 390px artboard the plate scrolls inside its own port instead of escaping
 * the specimen.
 */
const fixedPlateGeometry = {
  maxInlineSize: "100%",
  overflowX: "auto",
} as const;

export const Contract: StoryObj = {
  render: () => (
    <div style={fixedPlateGeometry}>
      <QrCode
        label="Scan this code with your authenticator app"
        modules={designQrModules}
      />
    </div>
  ),
};
