import { assertEquals } from "@std/assert";
import {
  aggregate,
  MetricKey,
  metricWindow,
  noDeployEvidence,
  PRODUCTION_DELIVERY_METRICS,
} from "../../apps/server/src/modules/delivery/metrics.ts";

const window = metricWindow(
  {
    from: "2026-06-01T00:00:00Z",
    to: "2026-06-04T00:00:00Z",
    resolution: "day",
  },
  new Date("2026-07-01T00:00:00Z"),
);

Deno.test("a production delivery metric is unknown for a named reason, never zero", () => {
  const body = noDeployEvidence(window);
  assertEquals(body.points.length, 3);
  for (const point of body.points) {
    assertEquals(point.value, null);
    assertEquals(point.unknownReason, "no_deploy_evidence");
  }
  assertEquals(body.sampleCount, 0);
  assertEquals(body.missingCount, 0);
  assertEquals(body.completeness, "unknown");
});

Deno.test("a count with records read but none placed would say zero, which is why deployments never take that path", () => {
  // The guard this slice adds: aggregate() on an empty count reads as zero
  // when the source has synced, so a deployment count must not go through it.
  const counted = aggregate(MetricKey.Opened, [], window, true);
  assertEquals(counted.points.map((p) => p.value), [0, 0, 0]);
  assertEquals(PRODUCTION_DELIVERY_METRICS.has(MetricKey.Opened), false);
  assertEquals(
    PRODUCTION_DELIVERY_METRICS.has(MetricKey.DeploymentFrequency),
    true,
  );
});
