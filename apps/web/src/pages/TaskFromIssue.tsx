import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { TicketTaskLinkResponse } from "../api/client.ts";
import {
  externalTicketQueryOptions,
  ticketLinksByTaskQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { issueNumber, issueSnapshot } from "./issue-state.ts";

/** One linked issue: "{repository}#{number} {title}" to its Bakery page, and its page on GitHub. */
function IssueLine(
  { link, label }: {
    readonly link: TicketTaskLinkResponse;
    readonly label: "fromIssue" | "mentions";
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const issue = useQuery({
    ...externalTicketQueryOptions(api, scope, link.externalTicketId),
    enabled: scope.organizationId !== null,
  });
  const row = issue.data;
  // An issue that cannot be read (removed, or not yours to see) is not shown.
  if (row === undefined) return null;
  const snapshot = issueSnapshot(row);
  const number = issueNumber(row);
  const reference = number === null
    ? snapshot.repository
    : `${snapshot.repository}#${number}`;
  return (
    <UI.Inline gap="compact" data-ui-region="issue-line">
      <UI.Text variant="muted">
        {translate(`tasks.fromIssue.${label}` as never)}
      </UI.Text>
      <UI.Link
        href={`/issues/${row.id}`}
        variant="quiet"
        onClick={(event) => {
          event.preventDefault();
          void navigate({
            to: "/issues/$issueId",
            params: { issueId: row.id },
          });
        }}
      >
        {reference} {snapshot.title}
      </UI.Link>
      <UI.Link
        href={row.safeUrl}
        variant="quiet"
        target="_blank"
        rel="noreferrer"
        aria-label={translate("tasks.fromIssue.viewNamed" as never, {
          reference,
        })}
      >
        {translate("tasks.fromIssue.view" as never)}
        <span aria-hidden="true">↗</span>
      </UI.Link>
    </UI.Inline>
  );
}

/**
 * On a task: the issue it came from, and the issues it only mentions. Shown
 * only from the server's links; a task with none shows nothing.
 */
export function TaskFromIssue({ taskId }: { readonly taskId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const links = useQuery({
    ...ticketLinksByTaskQueryOptions(api, scope, taskId),
    enabled: scope.organizationId !== null,
  });
  const items = links.data?.items ?? [];
  if (items.length === 0) return null;
  const primary = items.filter((link) => link.role === "primary");
  const mentions = items.filter((link) => link.role !== "primary");
  return (
    <UI.Stack gap="compact" data-testid="task-from-issue">
      {primary.map((link) => (
        <IssueLine key={link.id} link={link} label="fromIssue" />
      ))}
      {mentions.map((link) => (
        <IssueLine key={link.id} link={link} label="mentions" />
      ))}
    </UI.Stack>
  );
}
