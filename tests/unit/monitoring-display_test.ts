import { assertEquals } from "@std/assert";
import type {
  TelemetryDestination,
  TelemetryDestinationList,
} from "../../apps/web/src/api/client.ts";
import {
  atLimit,
  blankDraft,
  draftOfDestination,
  failingOf,
  filterDestinations,
  formProblem,
  issuesByField,
  kindsOf,
  measurementsOf,
  orderDestinations,
  reenterNeeded,
  unavailableFor,
  valuesToSend,
} from "../../apps/web/src/screens/monitoring/monitoring-display.ts";

const LIST = {
  kinds: [{
    kind: "otlp",
    label: "OpenTelemetry",
    fields: [
      {
        name: "address",
        label: "Address",
        help: "h",
        secret: false,
        required: true,
      },
      {
        name: "headerName",
        label: "Header name",
        help: "h",
        secret: false,
        required: false,
      },
      {
        name: "headerValue",
        label: "Header value",
        help: "h",
        secret: true,
        required: false,
      },
    ],
    measurements: ["results", "health"],
    unavailableReasons: { cost: "Bakery does not send this yet." },
  }, { nonsense: true }],
  measurements: [
    { kind: "cost", label: "Cost", help: "c" },
    { kind: "results", label: "Results", help: "r" },
    { kind: "health", label: "Health", help: "h" },
  ],
  destinations: [],
} as unknown as TelemetryDestinationList;

const SAVED = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "otlp",
  name: "Grafana",
  enabled: true,
  measurements: ["results"],
  settings: { address: "https://a.example.com", headerName: "Authorization" },
  secretFieldsSet: ["headerValue"],
  credentialUpdatedAt: "2026-11-01T09:00:00.000Z",
  state: "working",
  version: 2,
} as unknown as TelemetryDestination;

Deno.test("the kinds and measurements are read from the list, and a malformed kind is left out", () => {
  const kinds = kindsOf(LIST);
  assertEquals(kinds.map((kind) => kind.kind), ["otlp"]);
  assertEquals(kinds[0].fields.map((field) => field.secret), [
    false,
    false,
    true,
  ]);
  assertEquals(measurementsOf(LIST).map((info) => info.kind), [
    "cost",
    "results",
    "health",
  ]);
});

Deno.test("a new form ticks what the kind can take, and a kind cannot take the rest", () => {
  const [kind] = kindsOf(LIST);
  const infos = measurementsOf(LIST);
  assertEquals(blankDraft(kind, infos).measurements, ["results", "health"]);
  assertEquals(
    unavailableFor(kind, infos[0]),
    "Bakery does not send this yet.",
  );
  assertEquals(unavailableFor(kind, infos[1]), null);
});

Deno.test("a new destination needs a name, a measurement and its required fields", () => {
  const [kind] = kindsOf(LIST);
  const blank = blankDraft(kind, measurementsOf(LIST));
  assertEquals(formProblem(null, kind, blank), "name");
  assertEquals(formProblem(null, kind, { ...blank, name: "x" }), "required");
  assertEquals(
    formProblem(null, kind, {
      ...blank,
      name: "x",
      values: { ...blank.values, address: "https://a" },
    }),
    null,
  );
  assertEquals(
    formProblem(null, kind, { ...blank, name: "x", measurements: [] }),
    "measurements",
  );
});

Deno.test("changing the address of a destination with a saved secret asks for the secret again", () => {
  const [kind] = kindsOf(LIST);
  const draft = draftOfDestination(SAVED, kind);
  assertEquals(reenterNeeded(SAVED, kind, draft), false);
  assertEquals(formProblem(SAVED, kind, draft), null);
  const moved = {
    ...draft,
    values: { ...draft.values, address: "https://b.example.com" },
  };
  assertEquals(reenterNeeded(SAVED, kind, moved), true);
  assertEquals(formProblem(SAVED, kind, moved), "reenter");
  // Entering the secret again lets it save.
  const again = {
    ...moved,
    touchedSecrets: ["headerValue"],
    values: { ...moved.values, headerValue: "t" },
  };
  assertEquals(formProblem(SAVED, kind, again), null);
});

Deno.test("a save sends every value for a new destination and only the changed ones for a saved one", () => {
  const [kind] = kindsOf(LIST);
  const blank = { ...blankDraft(kind, measurementsOf(LIST)), name: "x" };
  assertEquals(
    valuesToSend(null, kind, {
      ...blank,
      values: { ...blank.values, address: "https://a" },
    }),
    { address: "https://a", headerName: "", headerValue: "" },
  );
  const draft = draftOfDestination(SAVED, kind);
  assertEquals(valuesToSend(SAVED, kind, draft), {});
  assertEquals(
    valuesToSend(SAVED, kind, {
      ...draft,
      values: { ...draft.values, headerName: "X-Key" },
    }),
    { headerName: "X-Key" },
  );
  assertEquals(
    valuesToSend(SAVED, kind, { ...draft, touchedSecrets: ["headerValue"] }),
    { headerValue: "" },
  );
});

Deno.test("a 422's issues are read into messages by field", () => {
  assertEquals(
    issuesByField([
      { path: "/values/address", message: "Enter the address." },
      { path: "/name", message: "Too long." },
      { path: "/measurements", message: "Choose one." },
    ]),
    {
      name: "Too long.",
      measurements: "Choose one.",
      values: { address: "Enter the address." },
    },
  );
});

const row = (name: string, state: string, kind = "otlp") =>
  ({
    ...SAVED,
    id: name,
    name,
    state,
    kind,
  }) as unknown as TelemetryDestination;

Deno.test("the list puts failing and dropping first, then every other state by name", () => {
  const ordered = orderDestinations([
    row("Zed", "working"),
    row("Old", "off"),
    row("Beta", "dropping_data"),
    row("Alpha", "working"),
    row("Honey", "failing"),
  ]);
  assertEquals(ordered.map((entry) => entry.name), [
    "Honey",
    "Beta",
    "Alpha",
    "Old",
    "Zed",
  ]);
});

Deno.test("the search matches a name or a kind's label, and the filters narrow it", () => {
  const all = [
    row("Grafana Cloud", "working"),
    row("Honeycomb", "failing"),
    row("Old collector", "off", "other"),
  ];
  const label = (kind: string) => kind === "otlp" ? "OpenTelemetry" : "Other";
  const none = { q: "", state: "all", kind: null } as const;
  assertEquals(filterDestinations(all, none, label).length, 3);
  assertEquals(
    filterDestinations(all, { ...none, q: " GRAFANA " }, label).map((entry) =>
      entry.name
    ),
    ["Grafana Cloud"],
  );
  assertEquals(
    filterDestinations(all, { ...none, q: "opentelemetry" }, label).length,
    2,
  );
  assertEquals(
    filterDestinations(all, { ...none, state: "failing" }, label).map((entry) =>
      entry.name
    ),
    ["Honeycomb"],
  );
  assertEquals(
    filterDestinations(all, { ...none, kind: "other" }, label).map((entry) =>
      entry.name
    ),
    ["Old collector"],
  );
  assertEquals(failingOf(all).map((entry) => entry.name), ["Honeycomb"]);
  assertEquals(atLimit(all), false);
});
