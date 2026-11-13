import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { WorkerResponse } from "../api/client.ts";
import {
  codingAgents,
  machineBadge,
  machineBadgeTone,
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
  if (reason !== null) {
    return reason.kind === "checkFailed"
      ? translate("machines.reason.checkFailed" as never, {
        count: reason.count,
      })
      : translate(`machines.reason.${reason.kind}` as never);
  }
  const agents = codingAgents(row.capabilities).map((agent) =>
    translate(`machines.agent.${agent}` as never)
  );
  return [
    translate(`machines.os.${row.os}` as never),
    ...(agents.length > 0 ? [agents.join(", ")] : []),
    translate("machines.slotCount" as never, { count: row.slots }),
  ].join(" · ");
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
 * The row's one control. It goes to the machine's page, so it is a link given
 * a button's frame, not a button: inside a table the stylesheet flattens every
 * `button` to one neutral look, which would hide which row has a fix to make.
 */
function RowAction(
  { row, onOpen, translate }: {
    row: MachineRow;
    onOpen: (row: MachineRow) => void;
    translate: Translator;
  },
) {
  const fix = machineRowAction(row) === "fix";
  return (
    <UI.Link
      href={`/machines/${row.id}`}
      variant={fix ? "primaryButton" : "button"}
      aria-label={translate(
        (fix ? "machines.row.fixNamed" : "machines.row.openNamed") as never,
        { name: row.name },
      )}
      onClick={(event) => {
        event.preventDefault();
        onOpen(row);
      }}
    >
      {translate((fix ? "machines.row.fix" : "machines.row.open") as never)}
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
  if (phone) {
    return (
      <>
        {loading && rows.length === 0
          ? (
            <UI.Text variant="muted" role="status">
              {translate("machines.loading" as never)}
            </UI.Text>
          )
          : null}
        <UI.Stack
          gap="none"
          role="list"
          aria-label={translate("machines.table" as never)}
          aria-busy={loading || undefined}
          data-list-state={loading ? "loading" : stale ? "stale" : "ready"}
        >
          {rows.map((row) => (
            <div key={row.id} role="listitem" data-machine-id={row.id}>
              <UI.StackedRow
                title={row.name}
                status={<MachineBadge row={row} translate={translate} />}
              >
                <UI.Text variant="caption">
                  {machineLine(row, translate)}
                </UI.Text>
                <RowAction row={row} onOpen={onOpen} translate={translate} />
              </UI.StackedRow>
            </div>
          ))}
        </UI.Stack>
      </>
    );
  }
  return (
    <UI.DataTable<MachineRow>
      caption={translate("machines.table" as never)}
      rows={[...rows]}
      state={loading ? "loading" : stale ? "stale" : "ready"}
      emptyMessage={translate("machines.filter.empty" as never)}
      getRowKey={(row) => row.id}
      columns={[
        {
          id: "machine",
          header: translate("machines.column.machine" as never),
          cell: (row) => (
            <UI.CellStack
              title={row.name}
              detail={machineLine(row, translate)}
            />
          ),
        },
        {
          id: "status",
          header: translate("machines.column.status" as never),
          cell: (row) => <MachineBadge row={row} translate={translate} />,
        },
        {
          id: "action",
          header: translate("machines.column.action" as never),
          cell: (row) => (
            <RowAction row={row} onOpen={onOpen} translate={translate} />
          ),
        },
      ]}
    />
  );
}
