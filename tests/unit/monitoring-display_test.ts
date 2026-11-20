import { assertEquals } from "@std/assert";
import type {
  TelemetryDestination,
  TelemetryDestinationList,
} from "../../apps/web/src/api/client.ts";
import {
  blankDraft,
  draftOfDestination,
  formProblem,
  issuesByField,
  kindsOf,
  measurementsOf,
  providerForDestination,
  providersOf,
  reenterNeeded,
  stateCountsOf,
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

Deno.test("providers are read from the list, and a malformed one is left out", () => {
  const providers = providersOf({
    providers: [
      {
        key: "honeycomb",
        name: "Honeycomb",
        description: "Send timings and health to Honeycomb.",
        kind: "otlp",
        prefill: { address: "https://api.honeycomb.io", ignored: 3 },
      },
      { name: "no key" },
      "nonsense",
    ],
  } as unknown as TelemetryDestinationList);
  assertEquals(providers.map((provider) => provider.key), ["honeycomb"]);
  assertEquals(providers[0].prefill, { address: "https://api.honeycomb.io" });
});

Deno.test("a new draft starts with the provider's own values", () => {
  const [kind] = kindsOf(LIST);
  const draft = blankDraft(kind, measurementsOf(LIST), {
    address: "https://api.honeycomb.io",
  });
  assertEquals(draft.values.address, "https://api.honeycomb.io");
  assertEquals(draft.values.headerName, "");
});

Deno.test("a destination shows its saved provider, else its kind's first, never a guess", () => {
  const providers = providersOf({
    providers: [
      {
        key: "opentelemetry",
        name: "OpenTelemetry",
        description: "",
        kind: "otlp",
        prefill: {},
      },
      {
        key: "grafana",
        name: "Grafana",
        description: "",
        kind: "otlp",
        prefill: {},
      },
    ],
  } as unknown as TelemetryDestinationList);
  const label = (kind: string) => `kind ${kind}`;
  assertEquals(
    providerForDestination(
      { kind: "otlp", provider: "grafana" },
      providers,
      label,
    ),
    { key: "grafana", name: "Grafana" },
  );
  assertEquals(
    providerForDestination({ kind: "otlp", provider: null }, providers, label),
    { key: "opentelemetry", name: "OpenTelemetry" },
  );
  assertEquals(
    providerForDestination({ kind: "other", provider: null }, providers, label),
    { key: "other", name: "kind other" },
  );
});

Deno.test("the state counts read as numbers and a missing one is zero", () => {
  assertEquals(
    stateCountsOf(
      {
        stateCounts: { all: 4, failing: 1, off: "x" },
      } as unknown as TelemetryDestinationList,
    ),
    {
      all: 4,
      working: 0,
      not_tested_yet: 0,
      failing: 1,
      dropping_data: 0,
      off: 0,
    },
  );
});
