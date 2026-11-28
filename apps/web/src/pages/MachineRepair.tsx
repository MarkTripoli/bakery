import { useState } from "react";
import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { STILL_WAITING_AFTER_MS } from "./machine-add.ts";
import { MachineStatusLine } from "./machine-arrival.tsx";
import { MachineCommand } from "./MachineCommand.tsx";
import { codingAgents } from "./machine-state.ts";
import type { EnrollmentInput } from "./machine-wizard.ts";
import type { MachineSystem } from "./machine-systems.ts";
import { SetupInstructions } from "./SetupInstructions.tsx";
import {
  isUnprovenWithSteps,
  UnprovenSystemNotice,
} from "./UnprovenSystemNotice.tsx";

export type RepairIssued = Readonly<{
  enrollmentId: string;
  enrollmentToken: string;
  command: string;
  expiresAt: string;
  issuedAt: number;
}>;

type RepairedMachine = {
  name: string;
  os: string;
  architecture: string;
  slots: number;
  capabilities?: unknown;
};

function repairInput(machine: RepairedMachine): EnrollmentInput {
  return {
    name: machine.name,
    os: machine.os as MachineSystem,
    architecture: machine.architecture,
    capabilities: Array.isArray(machine.capabilities)
      ? machine.capabilities.filter((value): value is string =>
        typeof value === "string"
      )
      : [],
    slots: machine.slots,
  };
}

export function MachineRepair(
  { machine, issued, expired, now, offline, onNewCommand, translate }: {
    machine: RepairedMachine;
    issued: RepairIssued;
    expired: boolean;
    now: number;
    offline: boolean;
    onNewCommand: () => void;
    translate: Translator;
  },
) {
  const [byHand, setByHand] = useState(false);
  const unproven = isUnprovenWithSteps(machine.os, machine.architecture);
  const steps = byHand || unproven;
  const newButton = (label: string) => (
    <UI.Inline gap="compact">
      <UI.Button variant="primary" disabled={offline} onClick={onNewCommand}>
        {translate(label as never)}
      </UI.Button>
    </UI.Inline>
  );
  return (
    <UI.SettingsSection
      title={translate("machines.repair.title" as never, {
        name: machine.name,
      })}
      variant="stack"
      data-testid="machine-repair"
    >
      {expired
        ? (
          <UI.Stack gap="standard">
            <UI.AlertBanner tone="warning" role="status">
              {translate(
                (steps
                  ? "machines.wizard.install.expired"
                  : "machines.add.expired") as never,
              )}
            </UI.AlertBanner>
            {newButton(
              steps
                ? "machines.wizard.install.newSettings"
                : "machines.add.new",
            )}
          </UI.Stack>
        )
        : (
          <UI.Stack gap="standard">
            {unproven
              ? (
                <UnprovenSystemNotice
                  os={machine.os}
                  architecture={machine.architecture}
                  translate={translate}
                />
              )
              : null}
            {steps
              ? (
                <SetupInstructions
                  input={repairInput(machine)}
                  agent={codingAgents(
                    repairInput(machine).capabilities,
                  )[0] ?? null}
                  code={issued.enrollmentToken}
                  expiresAt={issued.expiresAt}
                  now={now}
                  serverUrl={globalThis.location?.origin ?? ""}
                  translate={translate}
                />
              )
              : (
                <>
                  <MachineCommand
                    command={issued.command}
                    expiresAt={issued.expiresAt}
                    now={now}
                    translate={translate}
                  />
                  <UI.Inline gap="compact">
                    <UI.Button variant="text" onClick={() => setByHand(true)}>
                      {translate("machines.repair.byHand" as never)}
                    </UI.Button>
                  </UI.Inline>
                </>
              )}
            <MachineStatusLine
              progress={{
                kind: "waiting",
                stillWaiting: now - issued.issuedAt >= STILL_WAITING_AFTER_MS,
              }}
              translate={translate}
            />
          </UI.Stack>
        )}
    </UI.SettingsSection>
  );
}
