import type { MessageKey } from "@bakery/i18n";
import type { NowCard, ReleaseEnvironment, ReleaseView } from "./model.ts";

type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;

type ReleaseNow = Extract<NowCard, { kind: "release" }>;

export type ReleaseCopy = Readonly<{
  title: string;
  body: string;
  action: "goBack" | "tell" | "chooseNext" | null;
}>;

export function environmentWord(
  t: Translate,
  environment: ReleaseEnvironment,
  capital = false,
): string {
  return t(
    `tasks.delivery.release.${
      capital ? "envCap" : "env"
    }.${environment}` as MessageKey,
  );
}

export function releaseTone(
  status: ReleaseNow["status"],
): "information" | "success" | "warning" | "error" {
  switch (status) {
    case "healthy":
      return "success";
    case "degraded":
    case "unknown":
      return "warning";
    case "failed":
      return "error";
    case "queued":
    case "deploying":
    case "verifying":
    case "rolling_back":
    case "rolled_back":
      return "information";
  }
}

export function releaseCopy(t: Translate, now: ReleaseNow): ReleaseCopy {
  const environment = environmentWord(t, now.environment);
  const capital = environmentWord(t, now.environment, true);
  switch (now.status) {
    case "queued":
    case "deploying":
      return {
        title: t("tasks.delivery.release.releasing.title", { environment }),
        body: t("tasks.delivery.release.releasing.body", { environment }),
        action: null,
      };
    case "verifying":
      return {
        title: t("tasks.delivery.release.checking.title"),
        body: t("tasks.delivery.release.checking.body", { environment }),
        action: null,
      };
    case "healthy":
      return {
        title: t("tasks.delivery.release.healthy.title", { environment }),
        body: t("tasks.delivery.release.healthy.body"),
        action: "chooseNext",
      };
    case "degraded":
      return {
        title: t("tasks.delivery.release.degraded.title", { environment }),
        body: t(
          now.goBack === "offer"
            ? "tasks.delivery.release.degraded.bodyOffer"
            : now.goBack === "viewer"
            ? "tasks.delivery.release.degraded.bodyViewer"
            : "tasks.delivery.release.degraded.body",
        ),
        action: now.goBack === "offer" ? "goBack" : null,
      };
    case "failed": {
      const parts = [
        t("tasks.delivery.release.failed.body"),
        ...(now.rollbackFailed
          ? [t("tasks.delivery.release.failed.rollbackFailed", { environment })]
          : []),
        t("tasks.delivery.now.nextStep"),
      ];
      return {
        title: t("tasks.delivery.release.failed.title", { environment }),
        body: parts.join(" "),
        action: "tell",
      };
    }
    case "unknown":
      return {
        title: t("tasks.delivery.release.unknown.title"),
        body: t("tasks.delivery.release.unknown.body", { environment }),
        action: null,
      };
    case "rolling_back":
      return {
        title: t("tasks.delivery.release.goingBack.title"),
        body: t("tasks.delivery.release.goingBack.body", {
          environment: capital,
        }),
        action: null,
      };
    case "rolled_back":
      return {
        title: t("tasks.delivery.release.wentBack.title"),
        body: t("tasks.delivery.release.wentBack.body", {
          environment: capital,
        }),
        action: null,
      };
  }
}

export type ReleaseDetails = Readonly<{
  thisRelease: string;
  before: string | null;
}>;

export function releaseDetails(
  t: Translate,
  release: ReleaseView,
  shortCommit: (sha: string) => string,
): ReleaseDetails {
  const environment = environmentWord(t, release.environment);
  return {
    thisRelease: t("tasks.delivery.release.details.thisValue", {
      commit: shortCommit(release.commitSha),
      environment,
    }),
    before: release.previousCommitSha === null
      ? null
      : t("tasks.delivery.release.details.beforeValue", {
        commit: shortCommit(release.previousCommitSha),
        environment,
      }),
  };
}
