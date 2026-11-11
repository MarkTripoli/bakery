import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataTable, Stack, Text } from "@bakery/ui";

type Row = { id: string; owner: string; status: string; title: string };

const columns = [
  {
    id: "title",
    header: "Task",
    sortable: true,
    cell: (row: Row) => row.title,
  },
  { id: "owner", header: "Owner", cell: (row: Row) => row.owner },
  { id: "status", header: "Status", cell: (row: Row) => row.status },
];
const rows: Row[] = [
  {
    id: "184",
    title: "Build the component library",
    owner: "Alex",
    status: "Running",
  },
  { id: "185", title: "Review navigation", owner: "Sam", status: "Ready" },
];

const meta = {
  title: "Bakery/Organisms/DataTable",
  parameters: { catalogId: "ui.dataTable", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

const BaseContract: StoryObj = {
  render: () => {
    const table = (
      state:
        | "loading"
        | "empty"
        | "ready"
        | "error"
        | "sorting"
        | "stale"
        | "long-content",
      variant: "table" | "sheetList" = "table",
    ) => (
      <DataTable
        caption={`Work queue / ${state}`}
        columns={columns}
        error="The work queue could not be loaded."
        getRowKey={(row) => row.id}
        onSort={() => undefined}
        rows={state === "empty" || state === "loading" ? [] : rows}
        sort={{ id: "title", direction: "ascending" }}
        state={state}
        variant={variant}
      />
    );
    return (
      <Stack>
        <Text variant="caption">
          Loading · empty · ready · sorting · stale · long-content
        </Text>
        {table("loading")}
        {table("empty")}
        {table("ready")}
        {table("sorting")}
        {table("stale")}
        {table("long-content", "sheetList")}
        {table("error", "sheetList")}
        <DataTable
          caption="Repositories / ruled edge"
          columns={columns}
          getRowKey={(row) => row.id}
          inset="edge"
          onSelectRow={() => undefined}
          rows={rows}
          selectedRowKey="184"
          variant="ruled"
        />
      </Stack>
    );
  },
};

const RuledStory: StoryObj = {
  render: () => (
    <DataTable
      variant="ruled"
      caption="Plan lanes"
      columns={[
        {
          id: "lane",
          header: "Plan lanes",
          width: "260px",
          cell: (row: Row) => row.title,
        },
        { id: "status", header: "Status", cell: (row: Row) => row.status },
        {
          id: "owner",
          header: "Owner",
          align: "end",
          width: "140px",
          cell: (row: Row) => row.owner,
        },
      ]}
      rows={rows}
      getRowKey={(row: Row) => row.id}
    />
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {RuledStory.render?.(args, context)}
    </>
  ),
};
