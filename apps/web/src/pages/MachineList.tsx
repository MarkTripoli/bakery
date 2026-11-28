import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { WorkerResponse } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  codingAgents,
  formatMachineDate,
  machineBadge,
  machineBadgeTone,
  type MachineReason,
  machineReason,
  machineRowAction,
} from "./machine-state.ts";

type MachineRow = WorkerResponse;

/**
 * The line under a machine's name: the reason it cannot take work, in a
 * sentence, or else what it is: its system, the coding agents it runs and how
 * many tasks it takes at once.
 */
export function machineLine(
  row: MachineRow,
  translate: Translator,
): string {
  const reason = machineReason(row);
  if (reason !== null) return reasonText(reason, translate);
  const agents = codingAgents(row.capabilities).map((agent) =>
    translate(`machines.agent.${agent}` as never)
  );
  return [
    translate(`machines.os.${row.os}` as never),
    ...(agents.length > 0 ? [agents.join(", ")] : []),
    translate("machines.row.tasks" as never, {
      running: row.activeAttemptCount,
      slots: row.slots,
    }),
  ].join(" · ");
}

export function tasksAtRisk(row: MachineRow): number {
  const badge = machineBadge(row);
  return badge === "offline" || badge === "notResponding"
    ? row.unsettledAttemptCount ?? 0
    : 0;
}

function atRiskLine(
  row: MachineRow,
  translate: Translator,
): string | undefined {
  const count = tasksAtRisk(row);
  return count === 0
    ? undefined
    : translate("machines.row.mayBeLost" as never, { count });
}

function machineReasonLine(
  row: MachineRow,
  translate: Translator,
): string | undefined {
  const reason = machineReason(row);
  return reason === null ? undefined : reasonText(reason, translate);
}

function reasonText(reason: MachineReason, translate: Translator): string {
  if (reason.kind !== "checkFailed") {
    return translate(`machines.reason.${reason.kind}` as never);
  }
  if (reason.unchecked === undefined) {
    return translate("machines.reason.checkFailed" as never, {
      count: reason.count,
    });
  }
  return reason.count === 0
    ? translate("machines.reason.checkUnchecked" as never, {
      count: reason.unchecked,
    })
    : translate("machines.reason.checkMixed" as never, {
      failed: reason.count,
      unchecked: reason.unchecked,
    });
}

function MachineBadge(
  { row, translate }: { row: MachineRow; translate: Translator },
) {
  const badge = machineBadge(row);
  return (
    <UI.Badge tone={machineBadgeTone(badge)}>
      {translate(`machines.badge.${badge}` as never)}
    </UI.Badge>
  );
}

/**
 * The row's one control, to the machine's page. On a wide screen it is a link
 * given a button's frame: inside a table the stylesheet flattens every `button`
 * to one neutral look, which would hide which row needs a fix. On a phone the
 * rows are not a table, so it is the real button, full width under the line.
 */
function RowAction(
  { row, phone, onOpen, translate }: {
    row: MachineRow;
    phone: boolean;
    onOpen: (row: MachineRow) => void;
    translate: Translator;
  },
) {
  const fix = machineRowAction(row) === "fix";
  const named = translate(
    (fix ? "machines.row.fixNamed" : "machines.row.openNamed") as never,
    { name: row.name },
  );
  const label = translate(
    (fix ? "machines.row.fix" : "machines.row.open") as never,
  );
  if (phone) {
    return (
      <UI.Button
        variant={fix ? "primary" : "secondary"}
        aria-label={named}
        onClick={() => onOpen(row)}
      >
        {label}
      </UI.Button>
    );
  }
  return (
    <UI.Link
      href={`/machines/${row.id}`}
      variant={fix ? "primaryButton" : "button"}
      aria-label={named}
      onClick={(event) => {
        event.preventDefault();
        onOpen(row);
      }}
    >
      {label}
    </UI.Link>
  );
}

/**
 * One row per machine: its name, one line, ONE badge and ONE button. A table
 * on a wide screen, stacked rows on a phone. Nothing here reads the machine's
 * other dimensions (connectivity, mode, readiness): `machineBadge` has already
 * chosen the one that matters.
 */
export function MachineList(
  { rows, loading, stale, phone, onOpen, translate }: {
    rows: readonly MachineRow[];
    loading: boolean;
    stale: boolean;
    phone: boolean;
    onOpen: (row: MachineRow) => void;
    translate: Translator;
  },
) {
  const { locale, timeZone } = useI18n();
  if (loading && rows.length === 0) {
    // No headings until there is data: three rows' worth of placeholder.
    return (
      <>
        <UI.Text variant="muted" role="status">
          {translate("machines.loading" as never)}
        </UI.Text>
        <UI.Stack
          gap="standard"
          role="list"
          aria-label={translate("machines.table" as never)}
          aria-busy="true"
          data-list-state="loading"
        >
          {[0, 1, 2].map((index) => (
            <div key={index} role="listitem">
              <UI.Skeleton shape="row" />
            </div>
          ))}
        </UI.Stack>
      </>
    );
  }
  if (phone) {
    return (
      <UI.Stack
        gap="none"
        role="list"
        aria-label={translate("machines.table" as never)}
        data-list-state={stale ? "stale" : "ready"}
      >
        {rows.map((row) => (
          <div key={row.id} role="listitem" data-machine-id={row.id}>
            <UI.StackedRow
              title={row.name}
              status={<MachineBadge row={row} translate={translate} />}
            >
              <UI.Text variant="caption">
                {[machineLine(row, translate), atRiskLine(row, translate)]
                  .filter(Boolean).join(" ")}
              </UI.Text>
              <RowAction
                row={row}
                phone
                onOpen={onOpen}
                translate={translate}
              />
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable<MachineRow>
      caption={translate("machines.table" as never)}
      captionHidden
      variant="ruled"
      inset="edge"
      rowSize="double"
      rows={[...rows]}
      state={stale ? "stale" : "ready"}
      emptyMessage={translate("machines.filter.empty" as never)}
      getRowKey={(row) => row.id}
      getRowAttributes={(row) => ({ "data-machine-id": row.id })}
      columns={[
        {
          id: "machine",
          width: "28%",
          header: translate("machines.column.machine" as never),
          cell: (row) => (
            <UI.CellStack
              title={row.name}
              detail={[
                machineReasonLine(row, translate),
                atRiskLine(row, translate),
              ].filter(Boolean).join(" ") || undefined}
            />
          ),
        },
        {
          id: "system",
          header: translate("machines.column.system" as never),
          cell: (row) => translate(`machines.os.${row.os}` as never),
        },
        {
          id: "agents",
          header: translate("machines.column.agents" as never),
          cell: (row) => {
            const agents = codingAgents(row.capabilities).map((agent) =>
              translate(`machines.agent.${agent}` as never)
            );
            return agents.length > 0
              ? agents.join(", ")
              : translate("machines.agents.none" as never);
          },
        },
        {
          id: "slots",
          align: "end",
          header: translate("machines.column.slots" as never),
          cell: (row) =>
            translate("machines.row.tasksShort" as never, {
              running: row.activeAttemptCount,
              slots: row.slots,
            }),
        },
        {
          id: "lastSeen",
          header: translate("machines.column.lastSeen" as never),
          cell: (row) =>
            formatMachineDate(
              row.lastHeartbeatAt,
              locale,
              timeZone,
              translate("machines.never" as never),
            ),
        },
        {
          id: "status",
          header: translate("machines.column.status" as never),
          cell: (row) => <MachineBadge row={row} translate={translate} />,
        },
        {
          id: "action",
          align: "end",
          header: translate("machines.column.action" as never),
          cell: (row) => (
            <RowAction
              row={row}
              phone={false}
              onOpen={onOpen}
              translate={translate}
            />
          ),
        },
      ]}
    />
  );
}
