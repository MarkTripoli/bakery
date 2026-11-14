import { assertEquals } from "@std/assert";
import {
  changesOf,
  draftErrors,
  draftOf,
  isDirty,
  policyOf,
  sourceRows,
} from "../../apps/web/src/pages/issue-sources.ts";
import type {
  IntegrationResource,
  RepositoryResponse,
  TicketSourceResponse,
} from "../../apps/web/src/api/client.ts";

const repository = (
  id: string,
  name: string,
  extra: Partial<RepositoryResponse> = {},
): RepositoryResponse =>
  ({
    id,
    owner: "acme",
    name,
    integrationConnectionId: "conn",
    providerRepoId: id,
    archivedAt: null,
    ...extra,
  }) as RepositoryResponse;
const resource = (
  externalId: string,
  extra: Partial<IntegrationResource> = {},
): IntegrationResource =>
  ({
    id: `res-${externalId}`,
    connectionId: "conn",
    externalId,
    selected: true,
    available: true,
    ...extra,
  }) as IntegrationResource;
const source = (
  id: string,
  repositoryId: string,
  extra: Partial<TicketSourceResponse> = {},
): TicketSourceResponse =>
  ({
    id,
    repositoryId,
    integrationResourceId: `res-${repositoryId}`,
    enabled: true,
    version: 2,
    policy: {
      version: 1,
      labels: { execute: "go", planOnly: "plan", hold: "wait" },
      delegation: null,
      automatic: { enabled: true, since: "2026-01-01T00:00:00Z" },
      readiness: { requireAcceptanceCriteria: false },
      approval: { plan: "none" },
      preset: "fixed-coding",
    },
    ...extra,
  }) as TicketSourceResponse;

Deno.test("rows are the repositories not archived, in name order, with their resource and source", () => {
  const rows = sourceRows(
    [
      repository("2", "web"),
      repository("1", "api"),
      repository("3", "old", { archivedAt: "2026-01-01T00:00:00Z" }),
      repository("4", "unlisted"),
    ],
    [resource("1"), resource("2", { selected: false }), resource("3")],
    [source("s1", "1")],
  );
  assertEquals(rows.map((row) => row.repository.name), [
    "api",
    "unlisted",
    "web",
  ]);
  assertEquals(rows[0]?.resource?.id, "res-1");
  assertEquals(rows[0]?.source?.id, "s1");
  // Not selected in the connection: no resource, so nothing can be turned on.
  assertEquals(rows[2]?.resource, null);
  assertEquals(rows[1]?.resource, null);
});

Deno.test("a repository that never took issues starts with the defaults, off", () => {
  const [row] = sourceRows([repository("1", "api")], [resource("1")], []);
  assertEquals(draftOf(row!), {
    enabled: false,
    start: "bakery",
    hold: "hold",
  });
  assertEquals(isDirty(row!, draftOf(row!)), false);
  assertEquals(
    isDirty(row!, { enabled: true, start: "bakery", hold: "hold" }),
    true,
  );
});

Deno.test("a source shows its saved state and labels, and only a real change is dirty", () => {
  const [row] = sourceRows([repository("1", "api")], [resource("1")], [
    source("s1", "1"),
  ]);
  const saved = draftOf(row!);
  assertEquals(saved, { enabled: true, start: "go", hold: "wait" });
  assertEquals(isDirty(row!, saved), false);
  assertEquals(isDirty(row!, { ...saved, enabled: false }), true);
  assertEquals(isDirty(row!, { ...saved, start: "ship" }), true);
  // Labels of a row turned off are not compared.
  assertEquals(
    isDirty(row!, { enabled: true, start: " go ", hold: "wait" }),
    false,
  );
});

Deno.test("labels must be there and differ, ignoring case, only for a row that is on", () => {
  assertEquals(draftErrors({ enabled: false, start: "", hold: "" }), {});
  assertEquals(draftErrors({ enabled: true, start: "a", hold: "b" }), {});
  assertEquals(draftErrors({ enabled: true, start: " ", hold: "b" }), {
    start: "empty",
  });
  assertEquals(draftErrors({ enabled: true, start: "a", hold: "" }), {
    hold: "empty",
  });
  assertEquals(
    draftErrors({ enabled: true, start: "Bakery", hold: "bakery" }),
    { same: true },
  );
});

Deno.test("Save makes only the changes that can be made: create for a new source, update for an existing one", () => {
  const rows = sourceRows(
    [repository("1", "api"), repository("2", "web"), repository("3", "none")],
    [resource("1"), resource("2")],
    [source("s2", "2")],
  );
  const drafts = new Map([
    ["1", { enabled: true, start: "bakery", hold: "hold" }],
    ["2", { enabled: false, start: "go", hold: "wait" }],
    // No resource: cannot be created, whatever the switch says.
    ["3", { enabled: true, start: "bakery", hold: "hold" }],
  ]);
  const changes = changesOf(rows, drafts);
  assertEquals(
    changes.map((change) => [change.kind, change.row.repository.name]),
    [
      ["create", "api"],
      ["update", "web"],
    ],
  );
});

Deno.test("a policy keeps everything the source had except the two labels, and a new one gets the defaults", () => {
  const kept = policyOf(
    { enabled: true, start: " ship ", hold: "wait" },
    source("s", "1").policy,
  );
  assertEquals(kept.labels, {
    execute: "ship",
    planOnly: "plan",
    hold: "wait",
  });
  assertEquals(kept.readiness, { requireAcceptanceCriteria: false });
  assertEquals(kept.approval, { plan: "none" });
  assertEquals(kept.automatic, { enabled: true });
  const fresh = policyOf(
    { enabled: true, start: "bakery", hold: "hold" },
    null,
  );
  assertEquals(fresh, {
    version: 1,
    labels: { execute: "bakery", planOnly: null, hold: "hold" },
    delegation: null,
    automatic: { enabled: false },
    readiness: { requireAcceptanceCriteria: true },
    approval: { plan: "human_approval" },
    preset: "fixed-coding",
  });
});
