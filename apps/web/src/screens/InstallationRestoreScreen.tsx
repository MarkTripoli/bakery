import { useState } from "react";
import * as UI from "@bakery/ui";
import type {
  InstallationRestore,
  InstallationRestoreStep,
} from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { CopyValueButton } from "../pages/CopyValueButton.tsx";

/** The three steps of the ordered re-enable, in the order they are taken. */
export const RESTORE_STEPS: readonly {
  readonly id: InstallationRestoreStep;
  /** The step turns on something Bakery cannot see on the server, so the person confirms it. */
  readonly onServer: boolean;
  /** What to run on the server first, one command per block; none when the step says it in words. */
  readonly commands: readonly string[];
  readonly doneAt: "intakeEnabledAt" | "dispatchEnabledAt" | "workersEnabledAt";
  /** Who took the step, once the server says. */
  readonly doneBy: "intakeEnabledBy" | "dispatchEnabledBy" | "workersEnabledBy";
}[] = [
  {
    id: "intake",
    onServer: false,
    commands: [],
    doneAt: "intakeEnabledAt",
    doneBy: "intakeEnabledBy",
  },
  {
    id: "dispatch",
    onServer: true,
    // The two commands of the runbook's "After a restore" step 2.
    commands: ["runtime.sh background <sha>", "docker compose up -d inngest"],
    doneAt: "dispatchEnabledAt",
    doneBy: "dispatchEnabledBy",
  },
  {
    id: "workers",
    onServer: true,
    commands: [],
    doneAt: "workersEnabledAt",
    doneBy: "workersEnabledBy",
  },
];

/** Where the runbook's "After a restore" section lives. */
export const RESTORE_RUNBOOK_HREF =
  "https://github.com/MarkTripoli/bakery/blob/main/docs/runbooks/backups.md#after-a-restore";

export type RestoreScreenState =
  | "loading"
  | "ready"
  | "finished"
  | "notHeld"
  | "forbidden"
  | "error";

/** Why the last step was not taken, in the words the design gives each refusal. */
export type RestoreProblem = {
  readonly step: InstallationRestoreStep;
  readonly kind:
    | "mismatch"
    | "alreadyTaken"
    | "outOfOrder"
    | "notHeld"
    | "failed";
} | null;

export type InstallationRestoreScreenProps = {
  readonly state: RestoreScreenState;
  readonly restore: InstallationRestore | null;
  /** The step being taken now: its button is busy and nothing else can be taken. */
  readonly busyStep: InstallationRestoreStep | null;
  readonly problem: RestoreProblem;
  readonly onTakeStep: (
    step: InstallationRestoreStep,
    confirmation: string,
  ) => void;
  readonly onRetry: () => void;
  readonly onOpenAudit: () => void;
  readonly onOpenMachines: () => void;
};

/**
 * Finish the restore (#64 E3, design-ux ruling on #869): the three steps in
 * order beside what the restore did. Only the next step can be taken; the
 * steps that touch the server say what to run first, and every step asks for
 * the backup's name.
 */
export function InstallationRestoreScreen(
  props: InstallationRestoreScreenProps,
) {
  const { translate } = useI18n();
  const { state, restore } = props;
  return (
    <UI.SettingsContent data-page="installation-restore" variant="wide">
      <UI.Stack gap="standard">
        <UI.Heading level="page">
          {translate("installation.restore.title")}
        </UI.Heading>
        {state === "loading"
          ? (
            <UI.Stack
              aria-busy="true"
              aria-label={translate("installation.restore.loading")}
              gap="standard"
            >
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
            </UI.Stack>
          )
          : state === "error"
          ? (
            <UI.InlineNotice
              action={
                <UI.Button onClick={props.onRetry} variant="secondary">
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              role="alert"
              tone="error"
            >
              {translate("installation.restore.error")}
            </UI.InlineNotice>
          )
          : state === "forbidden"
          ? (
            // Nothing failed: the person may read, not finish. The neutral box of "No restore is waiting".
            <UI.EmptyState
              description={translate("installation.restore.forbidden.body")}
              title={translate("installation.restore.forbidden.title")}
            />
          )
          : state === "notHeld" || restore === null
          ? (
            <UI.EmptyState
              action={
                <UI.Button onClick={props.onOpenAudit} variant="secondary">
                  {translate("installation.restore.notHeld.audit")}
                </UI.Button>
              }
              description={translate("installation.restore.notHeld.body")}
              title={translate("installation.restore.notHeld.title")}
            />
          )
          : (
            // The record sits beside the steps: step 1 tells the person to read it first.
            <UI.FormWithSummary
              actions={state === "finished"
                ? (
                  <>
                    <UI.Button
                      onClick={props.onOpenAudit}
                      variant="secondary"
                    >
                      {translate("installation.restore.notHeld.audit")}
                    </UI.Button>
                    <UI.Button onClick={props.onOpenMachines}>
                      {translate("installation.restore.finished.openMachines")}
                    </UI.Button>
                  </>
                )
                : undefined}
              aside={
                <Record finished={state === "finished"} restore={restore} />
              }
            >
              {state === "finished"
                ? <Finished effectsHeld={restore.effectsHeld} />
                : (
                  <UI.Text variant="muted">
                    {translate("installation.restore.description")}
                  </UI.Text>
                )}
              <Steps {...props} restore={restore} />
            </UI.FormWithSummary>
          )}
      </UI.Stack>
    </UI.SettingsContent>
  );
}

function Finished({ effectsHeld }: { readonly effectsHeld: number }) {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice role="status" tone="success">
      <UI.Stack gap="tight">
        <UI.Text>{translate("installation.restore.finished.title")}</UI.Text>
        <UI.Text variant="muted">
          {translate("installation.restore.finished.body")}
        </UI.Text>
        <UI.Text>
          {translate("installation.restore.finished.nextTitle")}
        </UI.Text>
        <UI.Text variant="muted">
          {translate("installation.restore.finished.next", {
            count: effectsHeld,
          })}
        </UI.Text>
      </UI.Stack>
    </UI.InlineNotice>
  );
}

/** The backup's name, wrapped, with the way to copy it beside it. */
function BackupName({ name }: { readonly name: string }) {
  const { translate } = useI18n();
  return (
    <UI.Inline gap="compact">
      <UI.DataText fit state="wrapped" variant="identifier">{name}</UI.DataText>
      <CopyValueButton
        label={translate("installation.restore.confirm.copy")}
        value={name}
      />
    </UI.Inline>
  );
}

function Steps(
  props: InstallationRestoreScreenProps & {
    readonly restore: InstallationRestore;
  },
) {
  const { translate, locale, timeZone } = useI18n();
  const { restore } = props;
  const when = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  return (
    <UI.Stack data-testid="restore-steps" gap="standard">
      {props.problem !== null && props.problem.kind !== "mismatch"
        ? (
          <UI.InlineNotice
            role="alert"
            tone={props.problem.kind === "failed" ? "error" : "warning"}
          >
            {translate(`installation.restore.problem.${props.problem.kind}`, {
              number: RESTORE_STEPS.findIndex((other) =>
                other.id === restore.nextStep
              ) + 1,
              title: restore.nextStep === null ? "" : translate(
                `installation.restore.step.${restore.nextStep}.title`,
              ),
            })}
          </UI.InlineNotice>
        )
        : null}
      <UI.StepList label={translate("installation.restore.steps.label")}>
        {RESTORE_STEPS.map((step, index) => {
          const doneAt = restore[step.doneAt];
          const state = doneAt !== null
            ? "done" as const
            : restore.nextStep === step.id
            ? "next" as const
            : "later" as const;
          const problem =
            props.problem !== null && props.problem.step === step.id
              ? props.problem
              : null;
          return (
            <UI.StepItem
              data-restore-state={state}
              data-restore-step={step.id}
              key={step.id}
              // A done step is the tick; the others carry their number.
              number={state === "done" ? undefined : index + 1}
              status={state === "done"
                ? "done"
                : state === "next"
                ? "waiting"
                : "upcoming"}
              statusLabel={translate(
                `installation.restore.step.status.${state}`,
              )}
              summary={state === "done"
                ? (
                  <UI.Text>
                    {restore[step.doneBy] === null
                      ? translate("installation.restore.step.done", {
                        when: when(doneAt!),
                      })
                      : translate("installation.restore.step.doneBy", {
                        when: when(doneAt!),
                        name: restore[step.doneBy]!.displayName,
                      })}
                  </UI.Text>
                )
                : (
                  <UI.Stack gap="tight">
                    <UI.Text variant="muted">
                      {translate(`installation.restore.step.${step.id}.what`)}
                    </UI.Text>
                    {state === "later"
                      ? (
                        <UI.Text variant="muted">
                          {translate("installation.restore.step.waits", {
                            number: index,
                          })}
                        </UI.Text>
                      )
                      : null}
                  </UI.Stack>
                )}
              title={
                <UI.Inline gap="compact">
                  <span>
                    {translate(`installation.restore.step.${step.id}.title`)}
                  </span>
                  {state === "next"
                    ? null
                    : (
                      <UI.Badge tone={state === "done" ? "success" : "neutral"}>
                        {translate(
                          state === "done"
                            ? "installation.restore.step.on"
                            : "installation.restore.step.off",
                        )}
                      </UI.Badge>
                    )}
                </UI.Inline>
              }
            >
              {state === "next"
                ? (
                  <NextStepForm
                    busyStep={props.busyStep}
                    key={step.id}
                    onTakeStep={props.onTakeStep}
                    problem={problem}
                    restore={restore}
                    step={step}
                  />
                )
                : null}
            </UI.StepItem>
          );
        })}
      </UI.StepList>
    </UI.Stack>
  );
}

/**
 * The controls of the step that can be taken now. Its typed name and its
 * server-work tick belong to this step alone: it is keyed by the step, so the
 * next step starts unticked and empty and one confirmation never covers two.
 */
function NextStepForm(
  { busyStep, onTakeStep, problem, restore, step }: {
    readonly busyStep: InstallationRestoreStep | null;
    readonly onTakeStep: InstallationRestoreScreenProps["onTakeStep"];
    readonly problem: RestoreProblem;
    readonly restore: InstallationRestore;
    readonly step: typeof RESTORE_STEPS[number];
  },
) {
  const { translate } = useI18n();
  const [confirmation, setConfirmation] = useState("");
  const [ticked, setTicked] = useState(false);
  const busy = busyStep === step.id;
  const ready = confirmation === restore.backupName &&
    (!step.onServer || ticked);
  return (
    <UI.Stack gap="comfortable">
      {step.onServer
        ? (
          <UI.InlineNotice tone="information">
            <UI.Stack gap="compact">
              <UI.Text>
                {translate(`installation.restore.step.${step.id}.server`)}
              </UI.Text>
              {step.commands.map((command) => (
                <UI.CodeBlock code={command} key={command} variant="command" />
              ))}
              <UI.Text variant="muted">
                {translate("installation.restore.server.cannotSee")}
              </UI.Text>
              <UI.Link href={RESTORE_RUNBOOK_HREF}>
                {translate("installation.restore.server.runbook")}
              </UI.Link>
            </UI.Stack>
          </UI.InlineNotice>
        )
        : (
          <UI.Text variant="muted">
            {translate(`installation.restore.step.${step.id}.server`)}
          </UI.Text>
        )}
      {step.onServer
        ? (
          <UI.Checkbox
            checked={ticked}
            onChange={(event) => setTicked(event.currentTarget.checked)}
          >
            {translate("installation.restore.server.done")}
          </UI.Checkbox>
        )
        : null}
      <UI.Text>{translate("installation.restore.confirm.nameLabel")}</UI.Text>
      <BackupName name={restore.backupName} />
      <UI.Field
        error={problem?.kind === "mismatch"
          ? translate("installation.restore.problem.mismatch")
          : undefined}
        hint={translate("installation.restore.confirm.hint")}
        htmlFor={`restore-confirm-${step.id}`}
        label={translate("installation.restore.confirm.label")}
      >
        <UI.TextInput
          autoComplete="off"
          disabled={step.onServer && !ticked}
          id={`restore-confirm-${step.id}`}
          invalid={problem?.kind === "mismatch"}
          name="restore-confirmation"
          onChange={setConfirmation}
          type="text"
          value={confirmation}
        />
      </UI.Field>
      <UI.Inline gap="compact">
        <UI.Button
          disabled={!ready || busyStep !== null}
          loading={busy}
          onClick={() => {
            onTakeStep(step.id, confirmation);
          }}
        >
          {translate(`installation.restore.step.${step.id}.button`)}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}

function Record(
  { finished, restore }: {
    readonly finished: boolean;
    readonly restore: InstallationRestore;
  },
) {
  const { translate, locale, timeZone } = useI18n();
  const when = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  const counts = [
    { key: "effects", count: restore.effectsHeld },
    { key: "jobs", count: restore.jobsAwaitingReconciliation },
    { key: "workers", count: restore.workersRevoked },
  ] as const;
  return (
    <UI.Stack data-testid="restore-record" gap="tight">
      <UI.Heading level="section">
        {translate("installation.restore.record.heading")}
      </UI.Heading>
      <UI.DescriptionList>
        <UI.DescriptionItem
          description={<BackupName name={restore.backupName} />}
          title={translate("installation.restore.record.restoredFrom")}
        />
        <UI.DescriptionItem
          description={restore.cutoffAt === null
            ? translate("installation.restore.record.notRecorded")
            : when(restore.cutoffAt)}
          title={translate("installation.restore.record.cutoff")}
        />
        <UI.DescriptionItem
          description={when(restore.restoredAt)}
          title={translate("installation.restore.record.ran")}
        />
        {counts.map(({ key, count }) => (
          <UI.DescriptionItem
            description={count === 0
              ? translate(`installation.restore.record.${key}.none`)
              : key === "workers" && finished
              // Step 3 is done: no "before step 3" any more.
              ? translate("installation.restore.record.workers.bodyFinished")
              : translate(`installation.restore.record.${key}.body`)}
            key={key}
            title={count === 0
              ? undefined
              : translate(`installation.restore.record.${key}.title`, {
                count,
              })}
          />
        ))}
      </UI.DescriptionList>
    </UI.Stack>
  );
}
