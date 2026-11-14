import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { RepositoryResponse } from "../../api/client.ts";
import { repositoryBadge, repositoryName } from "./project-state.ts";

/** The one line under a repository's name: what is missing, or where it works from. */
function line(repository: RepositoryResponse, translate: Translator): string {
  const badge = repositoryBadge(repository);
  if (badge === "notSetUp") {
    return translate("projects.list.row.notSetUp" as never);
  }
  if (badge === "archived") {
    return translate("projects.list.row.archived" as never);
  }
  return translate("projects.list.row.branch" as never, {
    branch: repository.defaultBranch,
  });
}

function Badge(
  { repository, translate }: {
    repository: RepositoryResponse;
    translate: Translator;
  },
) {
  const badge = repositoryBadge(repository);
  if (badge === null) return null;
  return (
    <UI.Badge tone="neutral">
      {translate(`projects.list.badge.${badge}` as never)}
    </UI.Badge>
  );
}

/** Set up where nothing is set up yet, Open everywhere else. */
function RowAction(
  { onOpen, repository, translate }: {
    onOpen: (repository: RepositoryResponse) => void;
    repository: RepositoryResponse;
    translate: Translator;
  },
) {
  const setUp = repositoryBadge(repository) === "notSetUp";
  const name = repositoryName(repository);
  return (
    <UI.Button
      variant={setUp ? "primary" : "secondary"}
      aria-label={translate(
        (setUp
          ? "projects.list.row.setUpNamed"
          : "projects.list.row.openNamed") as never,
        { repository: name },
      )}
      onClick={() => onOpen(repository)}
    >
      {translate(
        (setUp ? "projects.list.row.setUp" : "projects.list.row.open") as never,
      )}
    </UI.Button>
  );
}

/**
 * One application's repositories: one badge (only where it is known) and one
 * button per row. A table on a wide screen, stacked rows on a phone.
 */
export function ProjectRows(
  { applicationName, onOpen, phone, repositories, translate }: {
    applicationName: string;
    onOpen: (repository: RepositoryResponse) => void;
    phone: boolean;
    repositories: readonly RepositoryResponse[];
    translate: Translator;
  },
) {
  if (phone) {
    return (
      <UI.Stack
        gap="none"
        role="list"
        aria-label={translate("projects.list.row.listNamed" as never, {
          application: applicationName,
        })}
      >
        {repositories.map((repository) => (
          <div
            key={repository.id}
            role="listitem"
            data-repository-id={repository.id}
          >
            <UI.StackedRow
              title={repositoryName(repository)}
              status={<Badge repository={repository} translate={translate} />}
            >
              <UI.Text variant="caption">{line(repository, translate)}</UI.Text>
              <RowAction
                onOpen={onOpen}
                repository={repository}
                translate={translate}
              />
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable<RepositoryResponse>
      caption={translate("projects.list.row.listNamed" as never, {
        application: applicationName,
      })}
      captionHidden
      headingsHidden
      variant="ruled"
      inset="edge"
      rowSize="double"
      rows={[...repositories]}
      state="ready"
      emptyMessage={translate("projects.list.row.none" as never)}
      getRowKey={(row) => row.id}
      getRowAttributes={(row) => ({ "data-repository-id": row.id })}
      columns={[
        {
          id: "repository",
          width: "56%",
          header: translate("projects.list.column.repository" as never),
          cell: (row) => (
            <UI.CellStack
              title={repositoryName(row)}
              detail={line(row, translate)}
            />
          ),
        },
        {
          id: "status",
          width: "20%",
          header: translate("projects.list.column.status" as never),
          cell: (row) => <Badge repository={row} translate={translate} />,
        },
        {
          id: "action",
          align: "end",
          header: translate("projects.list.column.action" as never),
          cell: (row) => (
            <RowAction
              onOpen={onOpen}
              repository={row}
              translate={translate}
            />
          ),
        },
      ]}
    />
  );
}
