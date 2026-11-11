import type { Meta, StoryObj } from "@storybook/react-vite";
import { createTranslator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import {
  type WorkerListState,
  workerListStates,
} from "../fixtures/worker-readiness.ts";
const meta = {
  title: "Bakery/Templates/WorkerCatalog",
  parameters: {
    catalogId: "template.workerCatalog",
    requiredCases: [
      "wr.list.ready.paper-list-light-desktop",
      "wr.list.ready.paper-list-light-phone",
      "wr.list.ready.paper-list-dark-desktop",
      "wr.list.ready.paper-list-dark-phone",

      "wr.list.ready.desktop-light-fine",
      "wr.list.ready.desktop-dark-fine",
      "wr.list.ready.worker-system-light",
      "wr.list.ready.system-dark",
      "wr.list.ready.phone-light-fine",
      "wr.list.ready.phone-light-coarse",
      "wr.list.ready.phone-dark-coarse",
      "wr.list.ready.zoom-200",
      "wr.list.ready.reduced-motion",
      "wr.list.ready.pseudo-locale",
      "wr.list.ready.rtl",
      "wr.list.ready.keyboard-focus",
      "wr.list.ready.worker-screen-reader",
      "wr.list.loading.desktop-light-fine",
      "wr.list.empty.desktop-light-fine",
      "wr.list.error.desktop-light-fine",
      "wr.list.forbidden.desktop-light-fine",
      "wr.list.conflict.desktop-light-fine",
      "wr.list.stale.desktop-light-fine",
      "wr.list.offline.desktop-light-fine",
      "wr.list.reconnecting.desktop-light-fine",
      "wr.list.expired.desktop-light-fine",
      "wr.list.revoked.desktop-light-fine",
      "wr.list.unavailable.desktop-light-fine",
      "wr.list.unproved.desktop-light-fine",
      "wr.list.worstcase.desktop-light-fine",
      "wr.list.worstcase.desktop-dark-fine",
      "wr.list.worstcase.worker-system-light",
      "wr.list.worstcase.system-dark",
      "wr.list.worstcase.phone-light-fine",
      "wr.list.worstcase.phone-light-coarse",
      "wr.list.worstcase.phone-dark-coarse",
      "wr.list.worstcase.zoom-200",
      "wr.list.worstcase.reduced-motion",
      "wr.list.worstcase.pseudo-locale",
      "wr.list.worstcase.rtl",
      "wr.list.worstcase.keyboard-focus",
      "wr.list.worstcase.worker-screen-reader",
    ],
  },
} satisfies Meta;
export default meta;
export const Contract: StoryObj<{ state: WorkerListState }> = {
  args: { state: "ready" },
  render: (args, context) => {
    if (!workerListStates.includes(args.state)) {
      throw new Error("Unknown list fixture state");
    }
    return (
      <UI.WorkerCatalog
        state={args.state}
        t={createTranslator({
          locale:
            context.globals?.locale === "pseudo" || args.state === "worstcase"
              ? "en-XA"
              : context.globals?.direction === "rtl"
              ? "ar-XB"
              : "en",
          surface: "worker-list-fixture",
        })}
      />
    );
  },
};
