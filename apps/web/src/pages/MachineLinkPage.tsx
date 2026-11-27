import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { ApiFailure, WorkerLinkRequestResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  organizationPeopleQueryOptions,
  organizationQueryOptions,
  workerQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { MACHINES_HOME, WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { timeAgo } from "./batches/batch-display.ts";
import {
  type AddAnswers,
  commandInput,
  initialAddAnswers,
} from "./machine-add.ts";
import {
  MachineArrived,
  MachineStatusLine,
  useMachineArrival,
} from "./machine-arrival.tsx";
import { MachineSettingsFields } from "./MachineSettingsFields.tsx";

type LinkRequest = WorkerLinkRequestResponse;
type Refusal = "codeRequired" | "unknownCode" | "tooMany" | "findFailed";

function findRefusal(error: ApiFailure): Refusal {
  if (error.kind !== "problem") return "findFailed";
  if (error.problem.code === "RESOURCE_NOT_FOUND") return "unknownCode";
  if (error.problem.code === "RATE_LIMITED") return "tooMany";
  return "findFailed";
}

function alreadyDecided(error: ApiFailure): boolean {
  return error.kind === "problem" &&
    (error.problem.code === "STATE_CONFLICT" ||
      error.problem.code === "RESOURCE_NOT_FOUND");
}

function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

export function MachineLinkPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale } = useI18n();
  useRestoreOrganizationScope();
  const organizationId = scope.organizationId;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const organization = useQuery(organizationQueryOptions(api, scope));
  const [code, setCode] = useState("");
  const [found, setFound] = useState<LinkRequest | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [answers, setAnswers] = useState<AddAnswers>(initialAddAnswers);
  const [showProblems, setShowProblems] = useState(false);
  const [approved, setApproved] = useState<LinkRequest | null>(null);
  const [failed, setFailed] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const approvedAt = useRef(Date.now());
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const arrival = useMachineArrival(
    approved?.enrollmentId ?? null,
    now,
    approvedAt.current,
  );
  const decidedElsewhere = found?.state === "approved";
  const people = useQuery({
    ...organizationPeopleQueryOptions(api, scope),
    enabled: Boolean(organizationId) && decidedElsewhere,
  });
  const joined = useQuery({
    ...workerQueryOptions(api, scope, found?.workerHostId ?? ""),
    enabled: Boolean(organizationId) && decidedElsewhere &&
      Boolean(found?.workerHostId),
  });

  const organizationName = organization.data?.name ??
    translate("machines.link.yourOrganization" as never);
  const say = (key: string, values?: Record<string, string | number>) =>
    translate(`machines.link.${key}` as never, values as never);
  const toList = () => void navigate({ to: "/machines" });
  const reset = () => {
    setCode("");
    setFound(null);
    setApproved(null);
    setRefusal(null);
    setFailed(null);
    setShowProblems(false);
    setAnswers(initialAddAnswers);
    attempt.current = null;
  };

  const look = async (userCode: string) => {
    if (!organizationId) return;
    setBusy(true);
    setRefusal(null);
    setFailed(null);
    const result = await api.workerLinkRequests.find({
      organizationId,
      userCode,
    });
    setBusy(false);
    if (!result.ok) {
      setFound(null);
      setRefusal(findRefusal(result.error));
      return;
    }
    setNow(Date.now());
    setFound(result.data);
    setAnswers({ ...initialAddAnswers, name: result.data.hostname });
    setShowProblems(false);
  };
  const find = () => {
    if (code.trim() === "") {
      setRefusal("codeRequired");
      return;
    }
    void look(code.trim());
  };
  const keyFor = (signature: string): string => {
    if (attempt.current?.signature !== signature) {
      attempt.current = { signature, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };
  const decide = async (decision: "approve" | "decline") => {
    if (!organizationId || found === null) return;
    const input = decision === "approve" ? commandInput(answers) : null;
    if (decision === "approve" && input === null) {
      setShowProblems(true);
      return;
    }
    setBusy(true);
    setFailed(null);
    const target = {
      organizationId,
      id: found.id,
      idempotencyKey: keyFor(JSON.stringify([found.id, decision, input])),
    };
    const result = input === null
      ? await api.workerLinkRequests.decline(target)
      : await api.workerLinkRequests.approve({ ...target, input });
    setBusy(false);
    if (!result.ok) {
      if (alreadyDecided(result.error)) {
        await look(code.trim());
        return;
      }
      setFailed(decision);
      return;
    }
    if (decision === "approve") {
      approvedAt.current = Date.now();
      setApproved(result.data);
      return;
    }
    setFound(result.data);
  };

  const frame = (lead: string | null, content: ReactNode) => (
    <>
      <ShellActiveNavigation id="machines" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              href: WORK_HOME,
              label: translate("shell.navigation.workspace"),
            },
            {
              href: MACHINES_HOME,
              label: translate("shell.navigation.machines"),
            },
            { label: say("title") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="machine-link">
        <UI.PageHeader
          flush
          variant="list"
          title={say("title")}
          {...(lead === null ? {} : { subtitle: lead })}
        />
        {content}
      </UI.SettingsContent>
    </>
  );
  const backButton = (variant: "primary" | "secondary") => (
    <UI.Button variant={variant} onClick={toList}>
      {translate("machines.wizard.toList" as never)}
    </UI.Button>
  );

  if (access.isPending) {
    return frame(
      null,
      <UI.Text variant="muted" role="status">
        {translate("machines.loading" as never)}
      </UI.Text>,
    );
  }
  if (access.isError) {
    return frame(
      null,
      <UI.ErrorState
        title={translate("machines.error.title" as never)}
        description={translate("machines.error.description" as never)}
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void access.refetch()}
          >
            {translate("machines.retry" as never)}
          </UI.Button>
        }
      />,
    );
  }
  if (!isAdmin) {
    return frame(
      null,
      <UI.EmptyState
        title={translate("machines.wizard.adminOnly.title" as never)}
        description={say("adminOnly")}
        action={
          <UI.Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard.writeText(
                `${globalThis.location.origin}/machines/link`,
              ).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied
              ? translate("machines.wizard.copied" as never)
              : say("copyAddress")}
          </UI.Button>
        }
        variant="firstUse"
      />,
    );
  }

  if (approved !== null) {
    const { progress } = arrival;
    if (progress?.kind === "ready" || progress?.kind === "attention") {
      return frame(
        null,
        <MachineArrived
          arrival={arrival}
          name={arrival.worker.data?.name ??
            (answers.name || approved.hostname)}
          agent={answers.agent}
          translate={translate}
          onAnother={() =>
            void navigate({
              to: "/machines/new",
              search: { finish: undefined },
            })}
        />,
      );
    }
    return frame(
      null,
      <UI.Stack gap="standard">
        {progress?.kind === "expired" || progress?.kind === "canceled"
          ? (
            <>
              <UI.AlertBanner tone="warning" role="status">
                {say("ranOut")}
              </UI.AlertBanner>
              <UI.Inline gap="compact">
                <UI.Button variant="primary" onClick={reset}>
                  {say("newCode")}
                </UI.Button>
                {backButton("secondary")}
              </UI.Inline>
            </>
          )
          : arrival.status.isError && arrival.status.data === undefined
          ? (
            <>
              <UI.AlertBanner tone="error" role="alert">
                {say("followFailed")}
              </UI.AlertBanner>
              <UI.Inline gap="compact">
                <UI.Button
                  variant="primary"
                  disabled={arrival.status.isFetching}
                  onClick={() => void arrival.status.refetch()}
                >
                  {translate("machines.retry" as never)}
                </UI.Button>
              </UI.Inline>
            </>
          )
          : (
            <MachineStatusLine
              progress={progress ?? { kind: "waiting", stillWaiting: false }}
              translate={translate}
            />
          )}
      </UI.Stack>,
    );
  }

  const expired = found !== null &&
    (found.state === "expired" ||
      (found.state === "pending" && Date.parse(found.expiresAt) <= now));

  if (found === null || expired) {
    return frame(
      say("lead"),
      <UI.Stack gap="standard">
        {expired
          ? (
            <UI.AlertBanner tone="warning" role="status">
              {say("expired", { code: found.userCode ?? code })}
            </UI.AlertBanner>
          )
          : null}
        {refusal === "tooMany" || refusal === "findFailed"
          ? (
            <UI.AlertBanner tone="error" role="alert">
              {say(refusal)}
            </UI.AlertBanner>
          )
          : null}
        <UI.Field
          label={say("code")}
          htmlFor="machine-link-code"
          hint={say("codeHint")}
          error={refusal === "codeRequired" || refusal === "unknownCode"
            ? say(refusal)
            : undefined}
          required
        >
          <UI.TextInput
            id="machine-link-code"
            name="code"
            type="text"
            autoComplete="off"
            invalid={refusal === "codeRequired" || refusal === "unknownCode"}
            value={code}
            onChange={setCode}
            onKeyDown={(event) => {
              if (event.key === "Enter") find();
            }}
          />
        </UI.Field>
        <UI.Inline gap="compact">
          <UI.Button variant="primary" disabled={busy} onClick={find}>
            {say("find")}
          </UI.Button>
          {backButton("secondary")}
        </UI.Inline>
      </UI.Stack>,
    );
  }

  if (found.state === "declined") {
    return frame(
      null,
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="information" role="status">
          {say("declined")}
        </UI.AlertBanner>
        <UI.Inline gap="compact">{backButton("primary")}</UI.Inline>
      </UI.Stack>,
    );
  }

  if (found.state === "approved") {
    const approver = people.data?.items.find((person) =>
      person.id === found.decidedBy
    )?.displayName;
    const ago = timeAgo(found.decidedAt ?? found.createdAt, now, locale);
    const hostId = found.workerHostId;
    return frame(
      null,
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="information" role="status">
          {approver === undefined
            ? say("approvedBySomeone", { ago })
            : say("approvedBy", { name: approver, ago })}
        </UI.AlertBanner>
        <UI.Inline gap="compact">
          {hostId === null ? null : (
            <UI.Button
              variant="primary"
              onClick={() =>
                void navigate({
                  to: "/machines/$machineId",
                  params: { machineId: hostId },
                  search: {},
                })}
            >
              {translate("machines.add.open" as never, {
                name: joined.data?.name ?? found.hostname,
              })}
            </UI.Button>
          )}
          {backButton(hostId === null ? "primary" : "secondary")}
        </UI.Inline>
      </UI.Stack>,
    );
  }

  const system = `${
    found.os === null
      ? say("unknownSystem")
      : translate(`machines.os.${found.os}` as never)
  } ${found.architecture === "x64" ? "x86_64" : found.architecture}`;
  return frame(
    say("foundLead", { organization: organizationName }),
    <UI.Stack gap="standard">
      <UI.Stack gap="compact">
        <UI.Text variant="muted">{say("checkCode")}</UI.Text>
        <UI.SetupKey variant="pairing">
          {found.userCode ?? code}
        </UI.SetupKey>
        <UI.Text variant="muted" data-testid="machine-link-says">
          {found.supported
            ? say("says", {
              host: found.hostname,
              system,
              minutes: minutesLeft(found.expiresAt, now),
            })
            : say("saysUnsupported", { host: found.hostname, system })}
        </UI.Text>
      </UI.Stack>
      {found.supported
        ? (
          <>
            <MachineSettingsFields
              answers={answers}
              onChange={setAnswers}
              showProblems={showProblems}
              translate={translate}
            />
            <UI.Text variant="muted">
              {say("warning", { organization: organizationName })}
            </UI.Text>
          </>
        )
        : (
          <UI.AlertBanner tone="warning" role="status">
            {say("unsupported", { system })}
          </UI.AlertBanner>
        )}
      {failed === null ? null : (
        <UI.AlertBanner tone="error" role="alert">
          {say(`${failed}Failed`)}
        </UI.AlertBanner>
      )}
      <UI.Inline gap="compact">
        {found.supported
          ? (
            <>
              <UI.Button
                variant="primary"
                disabled={busy}
                onClick={() => void decide("approve")}
              >
                {say("approve")}
              </UI.Button>
              <UI.Button
                variant="secondary"
                disabled={busy}
                onClick={() => void decide("decline")}
              >
                {say("decline")}
              </UI.Button>
            </>
          )
          : (
            <>
              <UI.Button
                variant="primary"
                disabled={busy}
                onClick={() => void decide("decline")}
              >
                {say("decline")}
              </UI.Button>
              {backButton("secondary")}
            </>
          )}
      </UI.Inline>
    </UI.Stack>,
  );
}
