import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { machineLine } from "./MachineList.tsx";
import type { MachineReason } from "./machine-state.ts";

export function bannerTitle(
  reason: MachineReason,
  machine: Parameters<typeof machineLine>[0] & {
    unsettledAttemptCount?: number;
  },
  translate: Translator,
): string {
  const unfinished = machine.unsettledAttemptCount;
  if (reason.kind !== "finishing" || unfinished === undefined) {
    return machineLine(machine, translate);
  }
  return unfinished === 0
    ? translate("machines.banner.finishedAll" as never)
    : translate("machines.banner.finishing" as never, { count: unfinished });
}

export function bannerBodyKey(
  reason: MachineReason,
  unfinished: number | undefined,
  canSetUpAgain: boolean,
): string {
  if (reason.kind === "retired" && !canSetUpAgain) {
    return "machines.banner.body.retiredNoSteps";
  }
  if (reason.kind === "paused" && (unfinished ?? 0) > 0) {
    return "machines.banner.body.pausedWithWork";
  }
  return `machines.banner.body.${reason.kind}`;
}

export function RetireWarning(
  { unfinished, translate }: {
    unfinished: number | undefined;
    translate: Translator;
  },
) {
  if (unfinished === 0) return null;
  return (
    <>
      <UI.Text>
        {unfinished === undefined
          ? translate("machines.retire.ifRunning" as never)
          : translate("machines.retire.running" as never, {
            count: unfinished,
          })}
      </UI.Text>
      <UI.Text>{translate("machines.retire.finishFirst" as never)}</UI.Text>
    </>
  );
}
