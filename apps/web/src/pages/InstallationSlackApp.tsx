import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiFailure, IntegrationSlackApp } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { integrationSlackAppQueryOptions } from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  type SlackAppSaved,
  SlackAppSection,
  type SlackAppStatus,
  type SlackAppView,
} from "../screens/SlackAppSection.tsx";
import {
  EMPTY_SLACK_APP,
  slackAppIdLooksRight,
  slackAppReady,
  type SlackAppValues,
} from "../screens/slack-app-details.ts";

/** The saved app as the section shows it, with every secret reduced to its date. */
function toSaved(app: IntegrationSlackApp): SlackAppSaved {
  return {
    configured: app.configured,
    appId: app.appId,
    clientId: app.clientId,
    clientSecretSavedAt: app.clientSecretSavedAt,
    signingSecretSavedAt: app.signingSecretSavedAt,
    detailsCheckedAt: app.detailsCheckedAt,
    detailsCheckResult: app.detailsCheckResult,
    lastRequestAt: app.lastRequestAt,
    lastRequestFailedAt: app.lastRequestFailedAt,
    redirectUrl: app.redirectUrl,
    eventsUrl: app.eventsUrl,
    interactivityUrl: app.interactivityUrl,
  };
}

/** What a refused press was doing, so the banner names the right verb. */
type SlackAppPress = "save" | "check" | "remove";

/**
 * The banner a refused press shows; every refusal stored nothing.
 *
 * A save names the field it refused, a check and a removal get their own words: a
 * failed removal reported as a failed save suggests the details are gone.
 */
function pressFailure(
  error: ApiFailure,
  press: SlackAppPress,
): SlackAppStatus {
  const status = failureStatus(error);
  const problem = error.kind === "problem" ? error.problem : null;
  const stale = status === 412 || status === 428 ||
    problem?.code === "STATE_CONFLICT" || status === 409;
  if (press === "check") return stale ? "checkStale" : "checkFailed";
  if (press === "remove") return stale ? "removeStale" : "removeFailed";
  if (stale) return "stale";
  if (status === 422) {
    // The server names the field it refused; the screen names it back.
    const named = problem?.reason ?? "";
    if (named.includes("client_id")) return "clientIdRefused";
    if (named.includes("client_secret")) return "clientSecretRefused";
  }
  return "failed";
}

/**
 * This installation's Slack app (#415): loads what is saved, saves the details
 * with the version it read, checks them with Slack, and removes them.
 *
 * The secrets are write-only, so a save that changes nothing but the two ids
 * still sends no secret: an omitted secret keeps the stored one.
 */
export function InstallationSlackApp() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = integrationSlackAppQueryOptions(api, scope);
  const slack = useQuery(options);
  const [values, setValues] = useState<SlackAppValues>(EMPTY_SLACK_APP);
  const [status, setStatus] = useState<SlackAppStatus>("idle");
  const [forbidden, setForbidden] = useState(false);
  useEffect(() => {
    setValues(EMPTY_SLACK_APP);
    setStatus("idle");
    setForbidden(false);
  }, [scope.sessionGeneration]);
  const loaded = slack.data;
  const saved = loaded ? toSaved(loaded) : null;
  const secretsStored = (loaded?.clientSecretSavedAt ?? null) !== null &&
    (loaded?.signingSecretSavedAt ?? null) !== null;
  const started = () => scope.sessionGeneration;
  // Replace shows the stored ids, so a person changing one secret does not retype
  // the pair; the secrets stay empty, which keeps what is stored.
  useEffect(() => {
    if (saved === null) return;
    setValues((current) =>
      current.appId === "" && current.clientId === "" && saved.configured
        ? {
          ...current,
          appId: saved.appId ?? "",
          clientId: saved.clientId ?? "",
        }
        : current
    );
  }, [saved?.appId, saved?.clientId, saved?.configured]);
  const [, save] = useSingleFlightSubmit(async () => {
    const current = values;
    if (!slackAppReady(current, secretsStored)) return;
    if (!slackAppIdLooksRight(current.appId)) return;
    setStatus("saving");
    const generation = started();
    const result = await api.integrationSlackApp.put({
      input: {
        appId: current.appId.trim(),
        clientId: current.clientId.trim(),
        // An empty secret field means "keep the stored one", so it is not sent.
        ...(current.clientSecret.trim() === ""
          ? {}
          : { clientSecret: current.clientSecret.trim() }),
        ...(current.signingSecret.trim() === ""
          ? {}
          : { signingSecret: current.signingSecret.trim() }),
      },
      ...(loaded && loaded.version > 0 ? { version: loaded.version } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    if (generation !== started()) return;
    if (result.ok) {
      queryClient.setQueryData(options.queryKey, result.data);
      setValues((current) => ({
        ...current,
        clientSecret: "",
        signingSecret: "",
      }));
      setStatus("idle");
      // The design promises one check after every save: the details are only
      // worth writing if Slack accepts them, and a saved-but-refused app must
      // say so without the person pressing anything. The check quotes the
      // version the save returned, not the one the page loaded with.
      checkVersion.current = result.data.version;
      void check();
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setStatus("idle");
      return;
    }
    // A save the server refused stored nothing; drop the secrets it refused so
    // nothing is resubmitted by accident, and keep the ids as typed.
    setValues((current) => ({
      ...current,
      clientSecret: "",
      signingSecret: "",
    }));
    setStatus(pressFailure(result.error, "save"));
    if (
      failureStatus(result.error) === 412 || failureStatus(result.error) === 428
    ) {
      void slack.refetch();
    }
  });
  // The version a check quotes is the one the save just made. The save leaves it
  // here and the check takes it, so a check right after a save never quotes the
  // version the page loaded with, which the save has just replaced.
  const checkVersion = useRef<number | undefined>(undefined);
  const [, check] = useSingleFlightSubmit(async () => {
    const current = checkVersion.current ?? loaded?.version;
    checkVersion.current = undefined;
    if (current === undefined) return;
    setStatus("checking");
    const generation = started();
    const result = await api.integrationSlackApp.check({
      version: current,
      idempotencyKey: crypto.randomUUID(),
    });
    if (generation !== started()) return;
    if (result.ok) {
      // The check records its own result on the app, so re-read rather than
      // pretend the answer in hand is the whole app.
      await queryClient.invalidateQueries({ queryKey: options.queryKey });
      setStatus("idle");
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setStatus("idle");
      return;
    }
    setStatus(pressFailure(result.error, "check"));
    if (
      failureStatus(result.error) === 412 || failureStatus(result.error) === 428
    ) {
      void slack.refetch();
    }
  });
  const [, remove] = useSingleFlightSubmit(async () => {
    if (!loaded) return;
    setStatus("removing");
    const generation = started();
    const result = await api.integrationSlackApp.remove({
      version: loaded.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (generation !== started()) return;
    if (result.ok) {
      queryClient.setQueryData(options.queryKey, result.data);
      setValues(EMPTY_SLACK_APP);
      setStatus("removed");
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setStatus("idle");
      return;
    }
    setStatus(pressFailure(result.error, "remove"));
    if (
      failureStatus(result.error) === 412 || failureStatus(result.error) === 428
    ) {
      void slack.refetch();
    }
  });
  const view: SlackAppView = forbidden ||
      (slack.isError && isForbiddenFailure(slack.error))
    ? "forbidden"
    : slack.isError
    ? "error"
    : !loaded
    ? "loading"
    : "ready";
  return (
    <SlackAppSection
      saved={saved}
      secretsStored={secretsStored}
      status={status}
      values={values}
      view={view}
      onChange={(field, value) => {
        setValues({ ...values, [field]: value });
        if (
          status !== "saving" && status !== "checking" &&
          status !== "removing"
        ) setStatus("idle");
      }}
      onCancel={() => {
        setValues(
          saved?.configured
            ? {
              ...EMPTY_SLACK_APP,
              appId: saved.appId ?? "",
              clientId: saved.clientId ?? "",
            }
            : EMPTY_SLACK_APP,
        );
        setStatus("idle");
      }}
      onCheck={() => void check()}
      onReload={() => void slack.refetch()}
      onRemove={() => void remove()}
      onSubmit={() => void save()}
    />
  );
}
