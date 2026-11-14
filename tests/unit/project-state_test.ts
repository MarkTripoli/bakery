import { assertEquals } from "@std/assert";
import {
  addRepositoryErrors,
  candidates,
  deriveSlug,
  hasArchived,
  matching,
  repositoryBadge,
  repositoryName,
  sections,
  splitFullName,
} from "../../apps/web/src/pages/projects/project-state.ts";
import type {
  ApplicationResponse,
  IntegrationResource,
  RepositoryResponse,
} from "../../apps/web/src/api/client.ts";

const application = (
  id: string,
  archivedAt: string | null = null,
): ApplicationResponse => ({ id, archivedAt } as ApplicationResponse);
const repository = (
  id: string,
  applicationId: string,
  extra: Partial<RepositoryResponse> = {},
): RepositoryResponse =>
  ({
    id,
    applicationId,
    integrationConnectionId: "conn",
    providerRepoId: id,
    owner: "acme",
    name: id,
    activeProfileId: null,
    archivedAt: null,
    ...extra,
  }) as RepositoryResponse;
const resource = (
  externalId: string,
  displayName: string,
  extra: Partial<IntegrationResource> = {},
): IntegrationResource =>
  ({
    id: `r-${externalId}`,
    connectionId: "conn",
    externalId,
    displayName,
    selected: true,
    available: true,
    ...extra,
  }) as IntegrationResource;

Deno.test("the badge says Not set up without working settings, Archived when archived, and nothing else is guessed", () => {
  assertEquals(
    repositoryBadge({ activeProfileId: null, archivedAt: null }),
    "notSetUp",
  );
  assertEquals(
    repositoryBadge({ activeProfileId: "p", archivedAt: null }),
    null,
  );
  assertEquals(
    repositoryBadge({
      activeProfileId: "p",
      archivedAt: "2026-01-01T00:00:00Z",
    }),
    "archived",
  );
  assertEquals(
    repositoryBadge({
      activeProfileId: null,
      archivedAt: "2026-01-01T00:00:00Z",
    }),
    "archived",
  );
  assertEquals(repositoryName({ owner: "acme", name: "web" }), "acme/web");
});

Deno.test("a short name comes from a name: lowercase, one dash between words, trimmed, never ending in a dash", () => {
  assertEquals(deriveSlug("Payments Web"), "payments-web");
  assertEquals(deriveSlug("  --Acme__API!! "), "acme-api");
  assertEquals(deriveSlug("Café Ünïcode"), "cafe-unicode");
  assertEquals(deriveSlug("!!!"), "");
  assertEquals(deriveSlug("a".repeat(150), 100).length, 100);
  assertEquals(deriveSlug("x".repeat(99) + " y", 100), "x".repeat(99));
});

Deno.test("owner/name is split only when it is exactly that", () => {
  assertEquals(splitFullName("acme/web"), { owner: "acme", name: "web" });
  assertEquals(splitFullName("acme/web/extra"), null);
  assertEquals(splitFullName("web"), null);
  assertEquals(splitFullName("acme/ web"), null);
  assertEquals(splitFullName("<img>/x"), null);
});

Deno.test("the picker offers what the connection selected and made available, marking what is already added", () => {
  const list = candidates(
    [
      resource("1", "acme/web"),
      resource("2", "acme/api"),
      resource("3", "acme/off", { selected: false }),
      resource("4", "acme/gone", { available: false }),
      resource("5", "not a full name"),
    ],
    [repository("1", "app", { providerRepoId: "1" })],
  );
  assertEquals(
    list.map((item) => [item.name, item.alreadyAdded]),
    [["web", true], ["api", false]],
  );
  // The same GitHub id on another connection is a different repository.
  assertEquals(
    candidates(
      [resource("1", "acme/web")],
      [repository("1", "app", {
        integrationConnectionId: "other",
        providerRepoId: "1",
      })],
    )[0]?.alreadyAdded,
    false,
  );
  // Archived repositories count as added: the server refuses a second one.
  assertEquals(
    candidates(
      [resource("1", "acme/web")],
      [repository("1", "app", {
        providerRepoId: "1",
        archivedAt: "2026-01-01T00:00:00Z",
      })],
    )[0]?.alreadyAdded,
    true,
  );
  assertEquals(matching(list, "API").map((item) => item.name), ["api"]);
  assertEquals(matching(list, "  ").length, 2);
});

Deno.test("step two names what is missing: an application, a short name that fits, a branch", () => {
  assertEquals(
    addRepositoryErrors({ slug: "web", branch: "main", applicationId: "a" }),
    {},
  );
  assertEquals(
    addRepositoryErrors({ slug: "", branch: " ", applicationId: "" }),
    {
      application: "empty",
      slug: "empty",
      branch: "empty",
    },
  );
  assertEquals(
    addRepositoryErrors({
      slug: "Web App",
      branch: "main",
      applicationId: "a",
    }),
    { slug: "invalid" },
  );
  assertEquals(
    addRepositoryErrors({ slug: "-web", branch: "main", applicationId: "a" }),
    { slug: "invalid" },
  );
});

Deno.test("sections keep the order read, hide archived ones unless asked, and count what is hidden", () => {
  const apps = [application("a"), application("b", "2026-01-01T00:00:00Z")];
  const repos = [
    repository("1", "a"),
    repository("2", "a", { archivedAt: "2026-01-01T00:00:00Z" }),
    repository("3", "b"),
  ];
  const quiet = sections(apps, repos, false);
  assertEquals(quiet.map((entry) => entry.application.id), ["a"]);
  assertEquals(quiet[0]?.repositories.map((entry) => entry.id), ["1"]);
  assertEquals(quiet[0]?.hiddenArchived, 1);
  const all = sections(apps, repos, true);
  assertEquals(all.map((entry) => entry.application.id), ["a", "b"]);
  assertEquals(all[0]?.repositories.map((entry) => entry.id), ["1", "2"]);
  assertEquals(hasArchived(apps, repos), true);
  assertEquals(hasArchived([application("a")], [repository("1", "a")]), false);
});
