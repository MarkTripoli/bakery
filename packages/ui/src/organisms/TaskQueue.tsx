import {
  createContext,
  Fragment,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import "../data.css";

export type TaskQueueRow = {
  id: string;
  reference?: ReactNode;
  title: string;
  href: string;
  application: ReactNode;
  stage: ReactNode;
  harness: ReactNode;
  age: ReactNode;
};

export type TaskQueueGroup = {
  id: string;
  label: ReactNode;
  rows: readonly TaskQueueRow[];
  /** List variant only: start the group folded behind its heading. */
  defaultCollapsed?: boolean;
};

export type TaskQueueLabels = {
  caption: string;
  task: string;
  application: string;
  stage: string;
  harness: string;
  age: string;
};

export type TaskQueueProps =
  & SemanticNativeProps<HTMLAttributes<HTMLDivElement>>
  & {
    groups: readonly TaskQueueGroup[];
    labels: TaskQueueLabels;
    selectedId?: string;
    /**
     * Columns the data can fill. A column the caller has no value for in any
     * row is hidden instead of showing a dash in every row.
     */
    columns?: { application?: boolean; harness?: boolean; stage?: boolean };
    variant?: "table" | "list";
    onOpen?: (event: MouseEvent<HTMLAnchorElement>, row: TaskQueueRow) => void;
    /** Preview a row (pointer on the row, or focus on its title link). */
    onPreview?: (row: TaskQueueRow) => void;
  };

/**
 * Grouped task triage rows. Callers own grouping, selection, navigation and
 * data; the queue renders a labelled table on wide layouts and stacked rows
 * on phones.
 */
export function TaskQueue(
  {
    columns,
    groups,
    labels,
    onOpen,
    onPreview,
    selectedId,
    variant = "table",
    ...props
  }: TaskQueueProps,
) {
  return (
    <div
      className={`ui-task-queue ui-task-queue--${variant}`}
      {...props}
      data-state={selectedId ? "selected" : "default"}
      data-ui-component="taskQueue"
      data-variant={variant}
    >
      {variant === "table"
        ? (
          <TableQueue
            columns={columns}
            groups={groups}
            labels={labels}
            onOpen={onOpen}
            onPreview={onPreview}
            selectedId={selectedId}
          />
        )
        : (
          <ListQueue
            columns={columns}
            groups={groups}
            labels={labels}
            onOpen={onOpen}
            onPreview={onPreview}
            selectedId={selectedId}
          />
        )}
    </div>
  );
}

type QueueBodyProps = Pick<
  TaskQueueProps,
  "columns" | "groups" | "labels" | "onOpen" | "onPreview" | "selectedId"
>;

function RowLink(
  { children, row, onOpen, onPreview, selected }: {
    children: ReactNode;
    row: TaskQueueRow;
    onOpen: TaskQueueProps["onOpen"];
    onPreview: TaskQueueProps["onPreview"];
    selected: boolean;
  },
) {
  const id = useId();
  return (
    <a
      aria-current={selected ? "true" : undefined}
      aria-describedby={`${id}-details`}
      aria-labelledby={`${id}-title`}
      className="ui-task-queue__link"
      href={row.href}
      onClick={(event) => onOpen?.(event, row)}
      onFocus={() => onPreview?.(row)}
    >
      <RowIds.Provider value={id}>{children}</RowIds.Provider>
    </a>
  );
}

const RowIds = createContext("");

function RowTitle({ children }: { children: ReactNode }) {
  const id = useContext(RowIds);
  return (
    <span className="ui-task-queue__title" id={`${id}-title`}>{children}</span>
  );
}

function RowDetails(
  { columns, row }: {
    columns: TaskQueueProps["columns"];
    row: TaskQueueRow;
  },
) {
  const id = useContext(RowIds);
  const parts = [
    row.reference,
    columns?.application !== false ? row.application : null,
    row.stage,
    row.age,
  ].filter((part) => part !== null && part !== undefined);
  return (
    <span id={`${id}-details`} hidden>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && " · "}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

function TableQueue(
  { columns, groups, labels, onOpen, onPreview, selectedId }: QueueBodyProps,
) {
  const application = columns?.application !== false;
  const harness = columns?.harness !== false;
  const stage = columns?.stage !== false;
  return (
    <table className="ui-task-queue__table">
      <caption className="ui-task-queue__caption">{labels.caption}</caption>
      <thead>
        <tr>
          <th scope="col">{labels.task}</th>
          {application && (
            <th className="ui-task-queue__application" scope="col">
              {labels.application}
            </th>
          )}
          {stage && (
            <th className="ui-task-queue__stage" scope="col">{labels.stage}</th>
          )}
          {harness && (
            <th className="ui-task-queue__harness" scope="col">
              {labels.harness}
            </th>
          )}
          <th className="ui-task-queue__age" scope="col">{labels.age}</th>
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.id}>
          <tr className="ui-task-queue__group">
            <th
              colSpan={2 + Number(application) + Number(stage) +
                Number(harness)}
              scope="colgroup"
            >
              {group.label}
            </th>
          </tr>
          {group.rows.map((row) => {
            const selected = row.id === selectedId;
            return (
              <tr
                className="ui-task-queue__row"
                data-selected={selected || undefined}
                key={row.id}
                onClick={() => onPreview?.(row)}
              >
                <td>
                  <RowLink
                    onOpen={onOpen}
                    onPreview={onPreview}
                    row={row}
                    selected={selected}
                  >
                    <RowTitle>{row.title}</RowTitle>
                    {row.reference !== undefined && (
                      <span className="ui-task-queue__reference">
                        {row.reference}
                      </span>
                    )}
                    <RowDetails columns={columns} row={row} />
                  </RowLink>
                </td>
                {application && <td>{row.application}</td>}
                {stage && <td>{row.stage}</td>}
                {harness && <td>{row.harness}</td>}
                <td className="ui-task-queue__age">{row.age}</td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

function ListGroup(
  { columns, group, labels, onOpen, onPreview, selectedId }:
    & Omit<QueueBodyProps, "groups">
    & { group: TaskQueueGroup },
) {
  const [collapsed, setCollapsed] = useState(group.defaultCollapsed ?? false);
  const listId = useId();
  return (
    <section
      aria-labelledby={`${listId}-label`}
      className="ui-task-queue__list-group"
    >
      {group.defaultCollapsed === undefined
        ? (
          <h2 className="ui-task-queue__group" id={`${listId}-label`}>
            {group.label}
          </h2>
        )
        : (
          <h2 className="ui-task-queue__group ui-task-queue__group--toggle">
            <button
              aria-controls={listId}
              aria-expanded={!collapsed}
              id={`${listId}-label`}
              onClick={() => setCollapsed(!collapsed)}
              type="button"
            >
              <span>{group.label}</span>
              <IconGlyph
                name={collapsed ? "chevron-down" : "chevron-up"}
                size="small"
              />
            </button>
          </h2>
        )}
      <ul hidden={collapsed} id={listId}>
        {group.rows.map((row) => {
          const selected = row.id === selectedId;
          const age = (
            <span className="ui-task-queue__age">
              <span className="ui-task-queue__visually-hidden">
                {labels.age}
              </span>
              {row.age}
            </span>
          );
          const stage = columns?.stage !== false ? row.stage : null;
          const about = columns?.application !== false
            ? (
              <>
                <span className="ui-task-queue__application">
                  {row.application}
                </span>
                {stage}
              </>
            )
            : stage && <span>{stage}</span>;
          return (
            <li
              className="ui-task-queue__row"
              data-selected={selected || undefined}
              key={row.id}
            >
              <RowLink
                onOpen={onOpen}
                onPreview={onPreview}
                row={row}
                selected={selected}
              >
                <RowTitle>{row.title}</RowTitle>
                {row.reference !== undefined
                  ? (
                    <>
                      <span className="ui-task-queue__line">
                        <span className="ui-task-queue__reference">
                          {row.reference}
                        </span>
                        {age}
                      </span>
                      <span className="ui-task-queue__line">{about}</span>
                    </>
                  )
                  : (
                    <span className="ui-task-queue__line">
                      {about}
                      {age}
                    </span>
                  )}
                <RowDetails columns={columns} row={row} />
              </RowLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ListQueue(
  { columns, groups, labels, onOpen, onPreview, selectedId }: QueueBodyProps,
) {
  return (
    <div aria-label={labels.caption} role="region">
      {groups.map((group) => (
        <ListGroup
          columns={columns}
          group={group}
          key={group.id}
          labels={labels}
          onOpen={onOpen}
          onPreview={onPreview}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}
