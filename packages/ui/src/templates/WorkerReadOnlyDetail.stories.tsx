import type { Meta, StoryObj } from "@storybook/react-vite";
import { createTranslator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import {
  type WorkerDetailState,
  workerDetailStates,
} from "../fixtures/worker-readiness.ts";

const meta = {
  title: "Bakery/Templates/WorkerReadOnlyDetail",
  parameters: {
    catalogId: "template.workerReadOnlyDetail",
    requiredCases: [
      "wr.detail.ready.desktop-light-fine",
      "wr.detail.ready.desktop-dark-fine",
      "wr.detail.ready.worker-system-light",
      "wr.detail.ready.system-dark",
      "wr.detail.ready.phone-light-fine",
      "wr.detail.ready.phone-light-coarse",
      "wr.detail.ready.phone-dark-coarse",
      "wr.detail.ready.zoom-200",
      "wr.detail.ready.reduced-motion",
      "wr.detail.ready.pseudo-locale",
      "wr.detail.ready.rtl",
      "wr.detail.ready.keyboard-focus",
      "wr.detail.ready.worker-screen-reader",
      "wr.detail.loading.desktop-light-fine",
      "wr.detail.empty.desktop-light-fine",
      "wr.detail.error.desktop-light-fine",
      "wr.detail.forbidden.desktop-light-fine",
      "wr.detail.conflict.desktop-light-fine",
      "wr.detail.stale.desktop-light-fine",
      "wr.detail.offline.desktop-light-fine",
      "wr.detail.reconnecting.desktop-light-fine",
      "wr.detail.expired.desktop-light-fine",
      "wr.detail.revoked.desktop-light-fine",
      "wr.detail.unavailable.desktop-light-fine",
      "wr.detail.unproved.desktop-light-fine",
      "wr.detail.worstcase.desktop-light-fine",
      "wr.detail.worstcase.desktop-dark-fine",
      "wr.detail.worstcase.worker-system-light",
      "wr.detail.worstcase.system-dark",
      "wr.detail.worstcase.phone-light-fine",
      "wr.detail.worstcase.phone-light-coarse",
      "wr.detail.worstcase.phone-dark-coarse",
      "wr.detail.worstcase.zoom-200",
      "wr.detail.worstcase.reduced-motion",
      "wr.detail.worstcase.pseudo-locale",
      "wr.detail.worstcase.rtl",
      "wr.detail.worstcase.keyboard-focus",
      "wr.detail.worstcase.worker-screen-reader",
      "wr.detail.ready.paper-detail-light-desktop",
      "wr.detail.ready.paper-detail-light-phone",
    ],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj<{ state: WorkerDetailState }> = {
  args: { state: "ready" },
  render: (args, context) => {
    const state = args.state;
    if (!workerDetailStates.includes(state)) {
      throw new Error("Unknown detail fixture state");
    }
    return (
      <UI.WorkerReadOnlyDetail
        state={state}
        t={createTranslator({
          locale: context.globals?.locale === "pseudo" || state === "worstcase"
            ? "en-XA"
            : context.globals?.direction === "rtl"
            ? "ar-XB"
            : "en",
          surface: "worker-detail-fixture",
        })}
      />
    );
  },
};
