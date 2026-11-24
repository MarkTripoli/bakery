import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import {
  hasSetupSteps,
  isSupportedSystem,
  processorLabel,
} from "./machine-systems.ts";

/** Whether the steps for this system are shown with a warning: they exist, but the system has no recorded run yet. */
export function isUnprovenWithSteps(os: string, architecture: string): boolean {
  return hasSetupSteps(os) && !isSupportedSystem(os, architecture);
}

/** The first line under the set-up-again heading for an enrolled machine whose system is not yet supported: it keeps its steps, and is told why. A plain line: the page already has its one banner. */
export function UnprovenSystemNotice(
  { os, architecture, translate }: {
    os: string;
    architecture: string;
    translate: Translator;
  },
) {
  return (
    <UI.Text id="machine-unproven-system" role="status">
      {translate("machines.wizard.unproven" as never, {
        system: translate(`machines.os.${os}` as never),
        processor: processorLabel(os, architecture),
      })}
    </UI.Text>
  );
}
