/**
 * #46 contract: every metric the server defines is a key the contract accepts,
 * nothing else is, and the production delivery metrics' unknown answer is a
 * named reason the client can show.
 */

import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  METRIC_DEFINITIONS,
  MetricKey,
  PRODUCTION_DELIVERY_METRICS,
} from "../../apps/server/src/modules/delivery/metrics.ts";

const KEYS = Object.values(MetricKey);

Deno.test("both metric reads accept exactly the server's metric keys", () => {
  for (
    const schema of [
      contractSchemas.MetricsQuery,
      contractSchemas.MetricSourcesQuery,
    ]
  ) {
    for (const metric of KEYS) {
      assert(schema.safeParse({ metric }).success, metric);
    }
    for (
      const metric of ["prs.unknown", "delivery.deployments", "", "PRS.OPENED"]
    ) {
      assertEquals(schema.safeParse({ metric }).success, false, metric);
    }
  }
});
Deno.test("the metric series read accepts weekly buckets", () => {
  assert(
    contractSchemas.MetricsQuery.safeParse({
      metric: MetricKey.Merged,
      resolution: "week",
    }).success,
  );
});

Deno.test("every metric key has a definition with a unit and a cohort", () => {
  assertEquals(Object.keys(METRIC_DEFINITIONS).sort(), [...KEYS].sort());
  for (const key of KEYS) {
    const definition = METRIC_DEFINITIONS[key];
    assert(definition.cohort.length > 20, key);
    assert(["count", "ratio", "hours", "lines"].includes(definition.unit), key);
  }
});

Deno.test("the production delivery metrics are the five DORA measures, placed by deployment", () => {
  assertEquals([...PRODUCTION_DELIVERY_METRICS].sort(), [
    "delivery.changeFailRate",
    "delivery.changeLeadTimeHours",
    "delivery.deploymentFrequency",
    "delivery.deploymentReworkRate",
    "delivery.failedDeploymentRecoveryHours",
  ]);
  for (const key of PRODUCTION_DELIVERY_METRICS) {
    assertEquals(METRIC_DEFINITIONS[key].placedBy, "deployed", key);
  }
});
