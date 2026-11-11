import type { Meta, StoryObj } from "@storybook/react-vite";
import { createTranslator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import {
  type WorkerEnrollmentState,
  workerEnrollmentStates,
} from "../fixtures/worker-readiness.ts";

const meta = {
  title: "Bakery/Templates/WorkerEnrollmentInstructions",
  parameters: {
    catalogId: "template.workerEnrollmentInstructions",
    requiredCases: [
      "wr.enrollment.start.paper-enrollment-start-desktop",
      "wr.enrollment.start.paper-enrollment-start-phone",
      "wr.enrollment.listening.paper-enrollment-listening-desktop",
      "wr.enrollment.listening.paper-enrollment-listening-phone",
      "wr.enrollment.connected.paper-enrollment-connected-desktop",
      "wr.enrollment.connected.paper-enrollment-connected-phone",
      "wr.enrollment.ready.desktop-light-fine",
      "wr.enrollment.ready.desktop-dark-fine",
      "wr.enrollment.ready.worker-system-light",
      "wr.enrollment.ready.system-dark",
      "wr.enrollment.ready.phone-light-fine",
      "wr.enrollment.ready.phone-light-coarse",
      "wr.enrollment.ready.phone-dark-coarse",
      "wr.enrollment.ready.zoom-200",
      "wr.enrollment.ready.reduced-motion",
      "wr.enrollment.ready.pseudo-locale",
      "wr.enrollment.ready.rtl",
      "wr.enrollment.ready.keyboard-focus",
      "wr.enrollment.ready.worker-screen-reader",
      "wr.enrollment.loading.desktop-light-fine",
      "wr.enrollment.empty.desktop-light-fine",
      "wr.enrollment.error.desktop-light-fine",
      "wr.enrollment.forbidden.desktop-light-fine",
      "wr.enrollment.conflict.desktop-light-fine",
      "wr.enrollment.stale.desktop-light-fine",
      "wr.enrollment.offline.desktop-light-fine",
      "wr.enrollment.reconnecting.desktop-light-fine",
      "wr.enrollment.expired.desktop-light-fine",
      "wr.enrollment.revoked.desktop-light-fine",
      "wr.enrollment.unavailable.desktop-light-fine",
      "wr.enrollment.unproved.desktop-light-fine",
      "wr.enrollment.worstcase.desktop-light-fine",
      "wr.enrollment.worstcase.desktop-dark-fine",
      "wr.enrollment.worstcase.worker-system-light",
      "wr.enrollment.worstcase.system-dark",
      "wr.enrollment.worstcase.phone-light-fine",
      "wr.enrollment.worstcase.phone-light-coarse",
      "wr.enrollment.worstcase.phone-dark-coarse",
      "wr.enrollment.worstcase.zoom-200",
      "wr.enrollment.worstcase.reduced-motion",
      "wr.enrollment.worstcase.pseudo-locale",
      "wr.enrollment.worstcase.rtl",
      "wr.enrollment.worstcase.keyboard-focus",
      "wr.enrollment.worstcase.worker-screen-reader",
    ],
  },
} satisfies Meta;
export default meta;

export const Contract: StoryObj<{ state: WorkerEnrollmentState }> = {
  args: { state: "ready" },
  render: (args, context) => {
    const state = args.state;
    if (!workerEnrollmentStates.includes(state)) {
      throw new Error("Unknown enrollment fixture state");
    }
    return (
      <UI.WorkerEnrollmentInstructions
        state={state}
        t={createTranslator({
          locale: context.globals?.locale === "pseudo" || state === "worstcase"
            ? "en-XA"
            : context.globals?.direction === "rtl"
            ? "ar-XB"
            : "en",
          surface: "worker-enrollment-fixture",
        })}
      />
    );
  },
};
