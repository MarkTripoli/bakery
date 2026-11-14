import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { TicketRequestIntent } from "../api/client.ts";
import {
  externalTicketQueryOptions,
  ticketSourcesListQueryOptions,
} from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { reasonSentence } from "./IssuesList.tsx";
import { type StartRefusal, StartWorkDialog } from "./StartWorkDialog.tsx";
import {
  issueBody,
  issueChecks,
  issueLinks,
  issueNumber,
  type IssueRow,
  issueSnapshot,
  type IssueStatus,
  issueStatus,
  reasonAction,
  startOffer,
} from "./issue-state.ts";

const BADGE_TONE = {
  canStart: "success",
  waiting: "warning",
  cannotStart: "neutral",
  inProgress: "information",
  waitingToStart: "warning",
  paused: "danger",
  closed: "neutral",
  unknown: "neutral",
} as const satisfies Record<
  IssueStatus,
  "neutral" | "success" | "warning" | "danger" | "information"
>;

const DEPENDENCY_TONE = {
  done: "success",
  open: "warning",
  closedUnmerged: "danger",
  unreadable: "neutral",
  unknown: "neutral",
} as const;

/** The sentence's next step: a link to where the fix lives, or a control, or nothing. */
function ReasonNext(
  { code, row, onCheck, onStart }: {
    code: string;
    row: IssueRow;
    onCheck: () => void;
    onStart: () => void;
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const action = reasonAction(code);
  if (action.kind === "none") return null;
  if (action.kind === "checkAgain") {
    return (
      <UI.Button variant="quiet" onClick={onCheck}>
        {translate("issues.card.checkAgain" as never)}
      </UI.Button>
    );
  }
  if (action.kind === "startAgain") {
    return (
      <UI.Button variant="quiet" onClick={onStart}>
        {translate("issues.start.button" as never)}
      </UI.Button>
    );
  }
  // The repository sheet that holds issue settings lands in part 3; until then
  // the sentence stands without a link rather than pointing at a page that
  // cannot change it.
  if (action.kind === "issueSettings") return null;
  if (action.kind === "askAdmin") {
    return (
      <UI.Text variant="muted">
        {translate("issues.next.askAdmin" as never)}
      </UI.Text>
    );
  }
  if (action.kind === "github") {
    return (
      <UI.Link
        href={row.safeUrl}
        variant="quiet"
        target="_blank"
        rel="noreferrer"
      >
        {translate(`issues.next.${action.label}` as never)}
        <span aria-hidden="true">↗</span>
      </UI.Link>
    );
  }
  const to = action.kind === "integrations"
    ? "/settings/organization/integrations" as const
    : "/projects/onboarding" as const;
  return (
    <UI.Button
      variant="quiet"
      onClick={() => void navigate({ to })}
    >
      {translate(
        (action.kind === "integrations"
          ? "issues.next.openIntegrations"
          : "issues.next.openProjects") as never,
      )}
    </UI.Button>
  );
}

/**
 * One issue: what it says, what it depends on and, in the side card, whether
 * Bakery can start it and why not. The card holds the answer and the button, so
 * on a phone it comes first.
 */
export function IssuePage({ issueId }: { readonly issueId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const ticket = useQuery(externalTicketQueryOptions(api, scope, issueId));
  const sources = useQuery(ticketSourcesListQueryOptions(api, scope));
  const [dialog, setDialog] = useState<TicketRequestIntent | null>(null);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const [started, setStarted] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const row = ticket.data;
  const source = sources.data?.items.find((item) =>
    item.id === row?.ticketSourceId
  );
  const policyRevision = source?.policyRevision ?? null;
  const check = useMutation({
    mutationKey: ["ticketReadiness.create"],
    mutationFn: async () => {
      const result = await api.tickets.check({
        organizationId: scope.organizationId as string,
        id: issueId,
        expectedSourcePolicyRevision: policyRevision as number,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });

  const notFound = ticket.isError && (isForbiddenFailure(ticket.error) ||
    (ticket.error as { status?: number })?.status === 404);
  const back = (
    <UI.Link
      href="/issues"
      variant="back"
      onClick={(event) => {
        event.preventDefault();
        void navigate({ to: "/issues" });
      }}
    >
      {translate("issues.back" as never)}
    </UI.Link>
  );

  if (ticket.isPending) {
    return (
      <>
        <UI.Stack gap="standard" aria-busy="true">
          {back}
          <UI.Text variant="muted" role="status">
            {translate("issues.loading" as never)}
          </UI.Text>
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="surface" />
        </UI.Stack>
      </>
    );
  }
  if (ticket.isError || row === undefined) {
    return (
      <>
        <UI.Stack gap="standard">
          {back}
          {notFound
            ? (
              <UI.AlertBanner tone="information">
                {translate("issues.notFound" as never)}
              </UI.AlertBanner>
            )
            : (
              <UI.ErrorState
                title={translate("issues.error.title" as never)}
                description={translate("issues.error.description" as never)}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void ticket.refetch()}
                  >
                    {translate("issues.retry" as never)}
                  </UI.Button>
                }
              />
            )}
        </UI.Stack>
      </>
    );
  }

  const number = issueNumber(row);
  const snapshot = issueSnapshot(row);
  const { status, reason } = issueStatus(row);
  const offer = startOffer(row);
  const links = issueLinks(row);
  const description = issueBody(row);
  const checks = issueChecks(row);
  const failing = checks.filter((entry) => entry.status !== "pass");
  const passing = checks.length - failing.length;
  const closed = snapshot.state === "closed";

  const card = (
    <UI.InspectorPanel
      label={translate("issues.card.title" as never)}
      variant={phone ? "stacked" : "column"}
      header={
        <UI.Heading level="section">
          {translate("issues.card.title" as never)}
        </UI.Heading>
      }
      footer={offer !== "none"
        ? (
          <UI.Stack gap="compact">
            <UI.Inline gap="compact">
              <UI.Button variant="primary" onClick={() => setDialog("start")}>
                {translate(
                  (offer === "start"
                    ? "issues.start.button"
                    : "issues.start.whenReady") as never,
                )}
              </UI.Button>
              {offer === "start"
                ? (
                  <UI.Button
                    variant="secondary"
                    onClick={() => setDialog("plan")}
                  >
                    {translate("issues.start.planFirst" as never)}
                  </UI.Button>
                )
                : null}
            </UI.Inline>
            <UI.Text variant="caption">
              {translate("issues.card.workflow" as never, {
                repository: snapshot.repository,
              })}
            </UI.Text>
          </UI.Stack>
        )
        : undefined}
    >
      <UI.Stack gap="standard">
        <UI.Badge tone={BADGE_TONE[status]}>
          {translate(`issues.status.${status}` as never)}
        </UI.Badge>
        {status === "inProgress"
          ? <UI.Text>{translate("issues.line.inProgress" as never)}</UI.Text>
          : null}
        {offer === "startWhenReady"
          ? (
            <UI.Text variant="muted">
              {translate("issues.card.startWhenReadyNote" as never)}
            </UI.Text>
          )
          : null}
        {failing.map((entry) => (
          <UI.Stack gap="compact" key={entry.id}>
            <UI.Text>{reasonSentence(row, entry.reason, translate)}</UI.Text>
            <ReasonNext
              code={entry.reason}
              row={row}
              onCheck={() => check.mutate()}
              onStart={() => setDialog("start")}
            />
          </UI.Stack>
        ))}
        {failing.length === 0 && status !== "canStart" && reason !== null
          ? <UI.Text>{reasonSentence(row, reason, translate)}</UI.Text>
          : null}
        {passing > 0
          ? (
            <UI.Stack gap="compact">
              <UI.Button
                variant="quiet"
                aria-expanded={showAll}
                onClick={() => setShowAll(!showAll)}
              >
                {translate("issues.card.passed" as never, { count: passing })}
              </UI.Button>
              {showAll
                ? checks.filter((entry) => entry.status === "pass").map((
                  entry,
                ) => (
                  <UI.Text variant="muted" key={entry.id}>
                    {translate(`issues.check.${entry.id}` as never)}
                  </UI.Text>
                ))
                : null}
            </UI.Stack>
          )
          : null}
        <UI.Button
          variant="quiet"
          disabled={check.isPending || policyRevision === null || closed}
          onClick={() => check.mutate()}
        >
          {translate("issues.card.checkAgain" as never)}
        </UI.Button>
        {check.isError
          ? (
            <UI.InlineNotice tone="error">
              {translate("issues.card.checkFailed" as never)}
            </UI.InlineNotice>
          )
          : null}
      </UI.Stack>
    </UI.InspectorPanel>
  );

  return (
    <>
      {phone ? null : <ShellSlot name="inspector">{card}</ShellSlot>}
      <UI.Stack gap="spacious" data-testid="issue-page">
        {back}
        {started
          ? (
            <UI.AlertBanner tone="success">
              {translate("issues.start.started" as never, {
                number: number ?? "",
              })}
            </UI.AlertBanner>
          )
          : null}
        {refusal === "notReady"
          ? (
            <UI.InlineNotice tone="warning">
              {translate("issues.refused.notReady" as never)}
            </UI.InlineNotice>
          )
          : refusal === "changed"
          ? (
            <UI.InlineNotice
              tone="warning"
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => {
                    setRefusal(null);
                    void queryClient.invalidateQueries({
                      queryKey: ["protected"],
                    });
                  }}
                >
                  {translate("issues.refused.reload" as never)}
                </UI.Button>
              }
            >
              {translate("issues.refused.changed" as never)}
            </UI.InlineNotice>
          )
          : refusal === "unavailable"
          ? (
            <UI.InlineNotice tone="warning">
              {translate("issues.refused.unavailable" as never)}
            </UI.InlineNotice>
          )
          : refusal === "failed"
          ? (
            <UI.InlineNotice tone="error">
              {translate("issues.refused.failed" as never)}
            </UI.InlineNotice>
          )
          : null}
        {phone ? card : null}
        <UI.Stack gap="compact">
          <UI.Heading level="page">
            {number === null ? snapshot.title : `#${number} ${snapshot.title}`}
          </UI.Heading>
          <UI.Text variant="muted">
            {snapshot.repository} · {translate(
              (closed ? "issues.page.closed" : "issues.page.open") as never,
            )} ·{" "}
            <UI.Link
              href={row.safeUrl}
              variant="quiet"
              target="_blank"
              rel="noreferrer"
              aria-label={translate("issues.row.openNamed" as never, {
                title: number === null
                  ? snapshot.title
                  : `#${number} ${snapshot.title}`,
              })}
            >
              {translate("issues.row.open" as never)}
              <span aria-hidden="true">↗</span>
            </UI.Link>
          </UI.Text>
        </UI.Stack>
        {description.body !== ""
          ? (
            <UI.Stack gap="compact">
              {description.body.split(/\n{2,}/).map((paragraph, index) => (
                <UI.Text key={index}>{paragraph}</UI.Text>
              ))}
              {description.truncated
                ? (
                  <UI.Text variant="muted">
                    {translate("issues.page.truncated" as never)}
                  </UI.Text>
                )
                : null}
            </UI.Stack>
          )
          : null}
        <UI.Stack gap="compact">
          <UI.Heading level="section">
            {translate("issues.page.dependsOn" as never)}
          </UI.Heading>
          {links.dependencies.length === 0
            ? (
              <UI.Text variant="muted">
                {translate("issues.page.noDependencies" as never)}
              </UI.Text>
            )
            : (
              <UI.DescriptionList>
                {links.dependencies.map((dependency) => (
                  <UI.DescriptionItem
                    key={`${dependency.repository}#${dependency.number}`}
                    title={
                      <UI.Link
                        href={`https://github.com/${dependency.repository}/issues/${dependency.number}`}
                        variant="quiet"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {dependency.repository}#{dependency.number}
                      </UI.Link>
                    }
                    action={
                      <UI.Badge tone={DEPENDENCY_TONE[dependency.state]}>
                        {translate(
                          `issues.dependency.${dependency.state}` as never,
                        )}
                      </UI.Badge>
                    }
                  />
                ))}
              </UI.DescriptionList>
            )}
          <UI.Text variant="muted">
            {[
              links.parent
                ? translate("issues.page.parent" as never, {
                  reference:
                    `${links.parent.repository}#${links.parent.number}`,
                })
                : null,
              translate(
                (links.subIssues > 0
                  ? "issues.page.subIssues"
                  : "issues.page.noSubIssues") as never,
                { count: links.subIssues },
              ),
            ].filter(Boolean).join(" · ")}
          </UI.Text>
          {links.incomplete
            ? (
              <UI.InlineNotice
                tone="warning"
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => check.mutate()}
                  >
                    {translate("issues.card.checkAgain" as never)}
                  </UI.Button>
                }
              >
                {translate("issues.page.linksIncomplete" as never)}
              </UI.InlineNotice>
            )
            : null}
        </UI.Stack>
      </UI.Stack>
      {dialog !== null
        ? (
          <StartWorkDialog
            intent={dialog}
            row={row}
            policyRevision={policyRevision}
            onClose={() => setDialog(null)}
            onDone={() => {
              setDialog(null);
              setRefusal(null);
              setStarted(true);
            }}
            onRefused={(why) => {
              setDialog(null);
              setStarted(false);
              setRefusal(why);
            }}
          />
        )
        : null}
    </>
  );
}
