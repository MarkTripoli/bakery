import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type MachinesFixtureState =
  | "default"
  | "ready"
  | "loading"
  | "empty"
  | "error"
  | "forbidden"
  | "stale"
  | "offline"
  | "reconnecting"
  | "expired"
  | "revoked"
  | "unavailable"
  | "accepted"
  | "complete"
  | "detail";

const enrollmentState = {
  accepted: "start",
  complete: "connected",
} as const;

export function MachinesFixture() {
  const { translate } = useI18n();
  const state = globalThis.location.pathname.split("/").at(-1) as
    | MachinesFixtureState
    | undefined;
  if (state === "detail") {
    return <UI.WorkerReadOnlyDetail state="ready" t={translate} embedded />;
  }
  if (state === "accepted" || state === "complete") {
    return (
      <UI.WorkerEnrollmentInstructions
        state={enrollmentState[state]}
        t={translate}
        embedded
      />
    );
  }
  const listState = state === "default" || state === undefined
    ? "ready"
    : state;
  return <UI.WorkerCatalog state={listState} t={translate} embedded />;
}
