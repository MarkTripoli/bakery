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
  readonly doneAt: "intakeEnabledAt" | "dispatchEnabledAt" | "workersEnabledAt";
  /** Who took the step, once the server says. */
  readonly doneBy: "intakeEnabledBy" | "dispatchEnabledBy" | "workersEnabledBy";
}[] = [
  {
    id: "intake",
    onServer: false,
    doneAt: "intakeEnabledAt",
    doneBy: "intakeEnabledBy",
  },
  {
    id: "dispatch",
    onServer: true,
    doneAt: "dispatchEnabledAt",
    doneBy: "dispatchEnabledBy",
  },
  {
    id: "workers",
    onServer: true,
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
};

/**
 * Finish the restore (#64 E3, design-ux): what the restore did, and the three
 * steps in order. Only the next step can be taken; the steps that touch the
 * server say what to run first, and every step asks for the backup's name.
 */
export function InstallationRestoreScreen(
  props: InstallationRestoreScreenProps,
) {
  const { translate } = useI18n();
  const { state, restore } = props;
  return (
    <UI.SettingsContent data-page="installation-restore">
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
            <UI.ErrorState
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
            <>
              {state === "finished" ? <Finished /> : (
                <UI.Text variant="muted">
                  {translate("installation.restore.description")}
                </UI.Text>
              )}
              <Steps {...props} restore={restore} />
              <Record restore={restore} />
            </>
          )}
      </UI.Stack>
    </UI.SettingsContent>
  );
}

function Finished() {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice role="status" tone="success">
      <UI.Stack gap="tight">
        <UI.Text>{translate("installation.restore.finished.title")}</UI.Text>
        <UI.Text variant="muted">
          {translate("installation.restore.finished.body")}
        </UI.Text>
        <UI.Text variant="muted">
          {translate("installation.restore.finished.next")}
        </UI.Text>
      </UI.Stack>
    </UI.InlineNotice>
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
  const [confirmation, setConfirmation] = useState("");
  const [ticked, setTicked] = useState(false);
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
      {RESTORE_STEPS.map((step, index) => {
        const number = index + 1;
        const doneAt = restore[step.doneAt];
        const isNext = restore.nextStep === step.id;
        const busy = props.busyStep === step.id;
        const matches = confirmation === restore.backupName;
        const ready = matches && (!step.onServer || ticked);
        const problem = props.problem !== null && props.problem.step === step.id
          ? props.problem
          : null;
        return (
          <UI.Stack
            data-restore-step={step.id}
            data-restore-state={doneAt !== null
              ? "done"
              : isNext
              ? "next"
              : "later"}
            gap="tight"
            key={step.id}
          >
            <UI.Inline gap="compact">
              <UI.Heading level="section">
                {translate("installation.restore.step.heading", {
                  number,
                  title: translate(
                    `installation.restore.step.${step.id}.title`,
                  ),
                })}
              </UI.Heading>
              <UI.Badge tone={doneAt !== null ? "success" : "neutral"}>
                {translate(
                  doneAt !== null
                    ? "installation.restore.step.on"
                    : "installation.restore.step.off",
                )}
              </UI.Badge>
            </UI.Inline>
            <UI.Text variant="muted">
              {translate(`installation.restore.step.${step.id}.what`)}
            </UI.Text>
            {doneAt !== null
              ? (
                <UI.Text>
                  {restore[step.doneBy] === null
                    ? translate("installation.restore.step.done", {
                      when: when(doneAt),
                    })
                    : translate("installation.restore.step.doneBy", {
                      when: when(doneAt),
                      name: restore[step.doneBy]!.displayName,
                    })}
                </UI.Text>
              )
              : !isNext
              ? (
                <UI.Text variant="muted">
                  {translate("installation.restore.step.waits", {
                    number: RESTORE_STEPS.findIndex((other) =>
                      other.id === restore.nextStep
                    ) + 1,
                  })}
                </UI.Text>
              )
              : (
                <UI.Stack gap="tight">
                  {step.onServer
                    ? (
                      <UI.InlineNotice tone="information">
                        <UI.Stack gap="tight">
                          <UI.Text>
                            {translate(
                              `installation.restore.step.${step.id}.server`,
                            )}
                          </UI.Text>
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
                        {translate(
                          `installation.restore.step.${step.id}.server`,
                        )}
                      </UI.Text>
                    )}
                  {step.onServer
                    ? (
                      <UI.Checkbox
                        checked={ticked}
                        onChange={(event) =>
                          setTicked(event.currentTarget.checked)}
                      >
                        {translate("installation.restore.server.done")}
                      </UI.Checkbox>
                    )
                    : null}
                  <UI.Text>
                    {translate("installation.restore.confirm.name", {
                      name: restore.backupName,
                    })}
                  </UI.Text>
                  <CopyValueButton
                    label={translate("installation.restore.confirm.copy")}
                    value={restore.backupName}
                  />
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
                      disabled={!ready || props.busyStep !== null}
                      loading={busy}
                      onClick={() => {
                        props.onTakeStep(step.id, confirmation);
                      }}
                    >
                      {translate(`installation.restore.step.${step.id}.button`)}
                    </UI.Button>
                  </UI.Inline>
                </UI.Stack>
              )}
          </UI.Stack>
        );
      })}
    </UI.Stack>
  );
}

function Record({ restore }: { readonly restore: InstallationRestore }) {
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
          description={restore.backupName}
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
