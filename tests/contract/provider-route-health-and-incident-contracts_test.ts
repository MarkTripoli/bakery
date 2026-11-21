import { assert, assertEquals } from "@std/assert";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";

/**
 * The read surface issue #26 slice 1 publishes: three nouns and the operations
 * that return them.
 *
 * Slice 1 published these as contracts with no handler. Slice 2 registered the
 * handlers, so the assertion now runs the other way: a catalogue entry with no
 * handler behind it tells a caller the feature exists, and an entry claiming to be
 * implemented with nothing serving it says the same thing. Both directions are the
 * same defect seen from a different side, so the check survives the change rather
 * than being deleted once it was inconvenient.
 */
const readActions = [
  {
    action: "providerRoutes.list",
    path: "/v1/provider-routes",
    input: "ProviderRouteQuery",
    output: "Page<ProviderRoute>",
  },
  {
    action: "providerRoutes.get",
    path: "/v1/provider-routes/{id}",
    input: "IdPath",
    output: "ProviderRoute",
  },
  {
    action: "providerRoutes.health",
    path: "/v1/provider-routes/{id}/health",
    input: "IdPath",
    output: "RouteHealth",
  },
  {
    action: "providerIncidents.list",
    path: "/v1/provider-incidents",
    input: "ProviderIncidentQuery",
    output: "Page<ProviderIncident>",
  },
  {
    action: "providerIncidents.get",
    path: "/v1/provider-incidents/{id}",
    input: "IdPath",
    output: "ProviderIncident",
  },
] as const;

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  anyOf?: JsonSchema[];
  format?: string;
  pattern?: string;
  description?: string;
};

// Read the published document rather than the in-memory Zod map: contracts.json
// is the artifact a consumer generates a client from, so a schema that only
// exists in the builder is not published at all.
const schemas = ((await Deno.readTextFile(
  new URL("../../packages/contracts/generated/contracts.json", import.meta.url),
).then(JSON.parse)) as { schemas: Record<string, JsonSchema> }).schemas;

function schemaOf(name: string): JsonSchema {
  const schema = schemas[name];
  assert(schema, `${name} is missing from the contract`);
  return schema;
}

/**
 * The fields a caller may omit. A fence that is merely present is not a fence:
 * absent reads as "no generation", which is the one answer that must never be
 * available to a decision that has to be ordered against one.
 */
function requiredOf(name: string): string[] {
  return [...(schemaOf(name).required ?? [])].sort();
}

function propertiesOf(name: string): Record<string, JsonSchema> {
  const schema = schemas[name];
  assert(schema, `${name} is missing from the contract`);
  assert(schema.properties, `${name} has no properties`);
  return schema.properties;
}

/** The non-null branch of a schema that may also be null. */
function enumOf(schema: JsonSchema, where: string): string[] {
  const branch = schema.enum
    ? schema
    : schema.anyOf?.find((option) => option.enum);
  assert(branch?.enum, `${where} is not an enum`);
  return [...branch.enum].sort();
}

Deno.test("the route reads are catalogued and served", () => {
  const catalogue = catalogActions as unknown as {
    action: string;
    method: string;
    path: string;
    access: string;
    permission: string;
    input: string;
    output: string;
  }[];

  for (const expected of readActions) {
    const entry = catalogue.find(({ action }) => action === expected.action);
    assert(entry, `${expected.action} is absent from the catalogue`);
    assertEquals(entry.method, "GET", expected.action);
    assertEquals(entry.path, expected.path, expected.action);
    assertEquals(entry.input, expected.input, expected.action);
    assertEquals(entry.output, expected.output, expected.action);
    // Reading what is paused is not administration: the developers whose runs
    // are blocked need the same view as the Admin who will decide the switch.
    assertEquals(entry.access, "Developer", expected.action);
    assert(
      entry.permission === "providerRoute:read" ||
        entry.permission === "providerIncident:read",
      `${expected.action} carries ${entry.permission}`,
    );
    // The guard was written the other way while these reads were catalogued and
    // unserved, and it caught exactly what it was for: the slice that serves them had
    // to come back and say so. Ticking the catalogue without a handler is the defect
    // this asserts against, so it is now stated in the direction that still fails -
    // a read that claims to be implemented must be one the server actually registers.
    assert(
      implementedActions.includes(expected.action as never),
      `${expected.action} is served by a handler, so it must claim to be implemented`,
    );
  }
});

Deno.test("a route carries the fence a paused decision is judged against", () => {
  const route = propertiesOf("ProviderRoute");

  // The generation is what makes a stale choice refusable: a continuation
  // offered while generation N was current cannot commit a switch after the
  // route recovered and generation advanced.
  assertEquals(route.incidentGeneration?.type, "integer");
  // Present is not the same as required: an optional fence can be omitted, and
  // a decision with no generation has nothing to be judged stale against.
  assert(
    requiredOf("ProviderRoute").includes("incidentGeneration"),
    "ProviderRoute.incidentGeneration must be required, not optional",
  );
  // Reachable is not usable. These two are separate on purpose: a status page
  // and a health read prove reachability, and only an already-authorized
  // request proves the inference path.
  assert(route.inferenceVerifiedAt, "inferenceVerifiedAt is missing");
  assert(route.nextProbeAt, "nextProbeAt is missing");
  assert(route.lastProbeAt, "lastProbeAt is missing");
  // A route is the unit an outage is scoped to, so it must name its provider
  // endpoint, model, harness and credential location together.
  // An endpoint that promises it carries no credential is only true if a
  // credential-bearing form cannot be written into it: `user:secret@host`,
  // `?token=`, `?access_token=` and a fragment are all refused by the pattern.
  assertEquals(route.endpoint?.pattern !== undefined, true);
  const endpoint = new RegExp(route.endpoint!.pattern!);
  for (
    const forbidden of [
      "https://user:secret@api.example.com/v1",
      "https://api.example.com/v1?token=abc",
      "https://api.example.com/v1?access_token=abc",
      "https://api.example.com/v1#secret",
      "https://api.example.com/v1?api_key=abc",
    ]
  ) {
    assertEquals(
      endpoint.test(forbidden),
      false,
      `${forbidden} must not be an acceptable endpoint`,
    );
  }
  for (
    const allowed of [
      "https://api.example.com/v1",
      "https://api.example.com/v1/models?page=2",
      "http://127.0.0.1:11434/v1/chat/completions",
    ]
  ) {
    assertEquals(
      endpoint.test(allowed),
      true,
      `${allowed} must be an acceptable endpoint`,
    );
  }
  for (
    const field of [
      "provider",
      "endpoint",
      "model",
      "harness",
      "billingRoute",
      "credentialLocation",
      "status",
      "health",
    ]
  ) {
    assert(route[field], `ProviderRoute.${field} is missing`);
  }
});

Deno.test("route health separates the probe schedule from the evidence", () => {
  const health = propertiesOf("RouteHealth");

  // One lease field is what makes duplicate wakes take one probe rather than
  // several: the second wake finds an unexpired lease and leaves it alone.
  assert(health.probeLeaseExpiresAt, "probeLeaseExpiresAt is missing");
  // The watermark deduplicates repeated observations of the same failure, so a
  // duplicate event cannot open a second incident.
  assert(health.evidenceWatermark, "evidenceWatermark is missing");
  assert(health.consecutiveFailures, "consecutiveFailures is missing");
  assertEquals(health.incidentGeneration?.type, "integer");
  assert(
    requiredOf("RouteHealth").includes("incidentGeneration"),
    "RouteHealth.incidentGeneration must be required, not optional",
  );
  assertEquals(
    enumOf(health.corroboration!, "RouteHealth.corroboration"),
    ["none", "status_page"],
  );
});

Deno.test("an incident is one record per generation, not one per failure", () => {
  const incident = propertiesOf("ProviderIncident");

  assertEquals(incident.generation?.type, "integer");
  assert(
    requiredOf("ProviderIncident").includes("generation"),
    "ProviderIncident.generation must be required, not optional",
  );
  assertEquals(
    enumOf(incident.status!, "ProviderIncident.status"),
    ["open", "recovered", "superseded"],
  );
  // Every paused task is counted once, however many probe results arrive, and
  // the outcome of each is visible: resumed, switched, or still blocked.
  for (
    const field of [
      "affectedTaskCount",
      "recoveredTaskCount",
      "switchedTaskCount",
      "stillBlockedTaskCount",
      "openedAt",
      "closedAt",
    ]
  ) {
    assert(incident[field], `ProviderIncident.${field} is missing`);
  }
});

Deno.test("the health states and reason codes cannot drift apart", () => {
  const route = propertiesOf("ProviderRoute");
  const health = propertiesOf("RouteHealth");
  const incident = propertiesOf("ProviderIncident");

  // The same four states are published on the list projection and the detail
  // view; the same reason codes are published on health and on the incident it
  // opened. A divergent copy would let a caller match a state to the wrong
  // reason, and nothing else in the build would notice.
  assertEquals(
    enumOf(route.health!, "ProviderRoute.health"),
    enumOf(health.health!, "RouteHealth.health"),
  );
  // One deliberate exception, stated rather than hidden: a redirect is a reason a
  // route *reads* (unverified, until it is reachable again) and never a reason an
  // incident *opens* with. The probe records a redirect as proving nothing, keeps
  // it out of failure counts, and opens no incident for it, so the incident
  // vocabulary is the health vocabulary minus exactly these.
  const healthOnlyReasons = ["redirected"];
  const healthReasons = enumOf(health.reason!, "RouteHealth.reason");
  const incidentReasons = enumOf(incident.reason!, "ProviderIncident.reason");
  assertEquals(
    healthReasons.filter((reason) => !healthOnlyReasons.includes(reason)),
    incidentReasons,
    "the incident reason vocabulary must match the route health vocabulary, " +
      "less the health-only reasons",
  );
  // And the exception is exact: every health-only reason is published on health
  // and none leaks into the incident vocabulary.
  for (const reason of healthOnlyReasons) {
    assert(healthReasons.includes(reason), `${reason} is not a health reason`);
    assert(
      !incidentReasons.includes(reason),
      `${reason} is health-only and must not be an incident reason`,
    );
  }

  // Machine codes, not prose: these are matched on, so a space or capital in
  // one of them is a bug rather than a wording choice.
  for (const reason of enumOf(health.reason!, "RouteHealth.reason")) {
    assert(
      /^[a-z][a-z_]*$/.test(reason),
      `${reason} is not a bounded machine reason code`,
    );
  }
});

Deno.test("both lists page by cursor only", () => {
  const routePage = schemas["Page<ProviderRoute>"];
  const incidentPage = schemas["Page<ProviderIncident>"];
  for (
    const [name, page] of [
      ["Page<ProviderRoute>", routePage],
      ["Page<ProviderIncident>", incidentPage],
    ] as const
  ) {
    assert(page, `${name} is missing from the contract`);
    const fields = Object.keys(propertiesOf(name));
    assert(
      fields.includes("items") && fields.includes("nextCursor"),
      `${name} does not page by keyset cursor`,
    );
    for (const forbidden of ["page", "offset", "total"]) {
      assert(
        !fields.includes(forbidden),
        `${name} exposes ${forbidden}; pagination is cursor-only`,
      );
    }
  }
});
