import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SearchField, Stack } from "@bakery/ui";

const meta = {
  title: "Bakery/Molecules/SearchField",
  parameters: { catalogId: "ui.searchField", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

function ResultsSearchField() {
  const [message, setMessage] = useState("2 matching tasks");
  return (
    <SearchField
      aria-label="Search results"
      data-testid="results-search"
      defaultValue="work"
      message={message}
      onChange={(event) =>
        setMessage(
          event.currentTarget.value ? "2 matching tasks" : "No matching tasks",
        )}
      state="results"
      variant="server"
    />
  );
}

export const Contract: StoryObj = {
  render: () => (
    <Stack>
      <SearchField
        aria-label="Search local tasks"
        placeholder="Search local tasks"
        state="empty"
        variant="local"
      />
      <SearchField
        aria-label="Search while typing"
        defaultValue="component"
        state="typing"
        variant="local"
      />
      <SearchField
        aria-label="Search server"
        defaultValue="navigation"
        message="Searching the workspace…"
        state="loading"
        variant="server"
      />
      <ResultsSearchField />
      <SearchField
        aria-label="Search error"
        defaultValue="missing"
        message="Search is unavailable."
        state="error"
        variant="server"
      />
      <SearchField
        aria-busy="true"
        aria-invalid="true"
        aria-label="Externally validated search"
        data-testid="external-search-state"
      />
    </Stack>
  ),
};
