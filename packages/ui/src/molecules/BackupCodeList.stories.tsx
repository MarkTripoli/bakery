import type { Meta, StoryObj } from "@storybook/react-vite";
import { BackupCodeList } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/BackupCodeList",
  parameters: { catalogId: "ui.backupCodeList", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

/** The eight codes the `backup-codes` artboards print (`auth.js` L103). */
const codes = [
  "h7mk2-9pvx4",
  "r3nb8-2qfw6",
  "d9tx5-4kma7",
  "w6cp3-8jyh2",
  "m2vz7-5xrd9",
  "k8hs4-3nwp6",
  "t5jq9-7bcv3",
  "p4fr6-2zmk8",
];

/**
 * A recovery code must stay one unbroken monospaced token to be readable and
 * selectable, so Paper's two-column plate (auth.css:23) cannot reflow below
 * its 390px artboard: there the plate scrolls inside its own port instead of
 * escaping the specimen.
 */
const fixedPlateGeometry = {
  maxInlineSize: "100%",
  overflowX: "auto",
} as const;

export const Contract: StoryObj = {
  render: () => (
    <div style={fixedPlateGeometry}>
      <BackupCodeList codes={codes} />
    </div>
  ),
};
