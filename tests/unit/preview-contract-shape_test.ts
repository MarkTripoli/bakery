import { assert, assertEquals } from "@std/assert";

type Schemas = {
  projections: Record<string, Record<string, unknown>>;
  outputs: Record<string, Record<string, unknown>>;
};

const schemas = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../docs/technical-design/transport-schemas.json",
      import.meta.url,
    ),
  ),
) as Schemas;

/** The route key and port are for the proxy alone; no read may carry them. */
const SERVER_ONLY = ["routeKey", "upstreamPort", "workspaceId"];
const SERVER_ONLY_COLUMNS = ["route_key", "upstream_port", "workspace_id"];

Deno.test("no preview read carries the route key, the port or a workspace", () => {
  for (
    const [label, entry] of [
      ["projection previews", schemas.projections.previews],
      ["output Preview", schemas.outputs.Preview],
    ] as const
  ) {
    for (
      const section of [
        "fields",
        "fieldTypes",
        "fieldDescriptions",
        "sourceColumns",
      ]
    ) {
      const value = entry[section];
      if (value === undefined) continue;
      const names = Array.isArray(value)
        ? value as string[]
        : Object.keys(value as Record<string, unknown>);
      for (const name of names) {
        assert(
          !SERVER_ONLY.includes(name),
          `${label}.${section} lists ${name}`,
        );
      }
    }
  }
  const columns = Object.values(
    schemas.projections.previews.sourceColumns as Record<string, string>,
  );
  for (const column of SERVER_ONLY_COLUMNS) {
    assert(!columns.includes(column), `sourceColumns lists ${column}`);
  }
  // Every listed field has a type, a description and (in the projection) a column.
  const projection = schemas.projections.previews;
  const fields = projection.fields as string[];
  assertEquals(
    Object.keys(projection.fieldTypes as object).sort(),
    [...fields].sort(),
  );
  assertEquals(
    Object.keys(projection.sourceColumns as object).sort(),
    [...fields].sort(),
  );
});
