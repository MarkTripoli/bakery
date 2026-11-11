import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, QrCode, QrSetup, SetupKey, Text } from "@bakery/ui";
import { designQrModules } from "../examples/qr-design-matrix.ts";

const meta = {
  title: "Bakery/Molecules/QrSetup",
  parameters: { catalogId: "ui.qrSetup", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/**
 * The row holds Paper's fixed 176px `.totp-qr` plate beside a 190px manual
 * column (auth.css:22), so below the design's narrowest 390px artboard the
 * enrolment row scrolls inside its own port instead of escaping the
 * specimen.
 */
const fixedPlateGeometry = {
  maxInlineSize: "100%",
  overflowX: "auto",
} as const;

export const Contract: StoryObj = {
  render: () => (
    <div style={fixedPlateGeometry}>
      <QrSetup
        code={
          <QrCode
            label="Scan this code with your authenticator app"
            modules={designQrModules}
          />
        }
      >
        <Text variant="hint">Can't scan it? Enter this key instead.</Text>
        <SetupKey>JBSW Y3DP EHPK 3PXP</SetupKey>
        <Button variant="secondary">Copy key</Button>
      </QrSetup>
    </div>
  ),
};
