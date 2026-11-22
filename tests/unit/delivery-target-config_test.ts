import { assertEquals, assertThrows } from "@std/assert";
import { readDeliveryTargetConfig } from "../../packages/config/src/env.ts";

/** #43: the local delivery target is configured as a whole or not at all. */

const FULL = {
  BAKERY_DELIVERY_RELEASE_ROOT: "/srv/bakery/releases",
  BAKERY_DELIVERY_ARTIFACTS_DIR: "/srv/bakery/artifacts",
  BAKERY_DELIVERY_HEALTH_URL: "http://127.0.0.1:8000/health/ready",
  BAKERY_DELIVERY_ENVIRONMENT: "production",
};

Deno.test("no delivery variable means no target, and a full set reads as one (#43)", () => {
  assertEquals(readDeliveryTargetConfig({}), undefined);
  assertEquals(
    readDeliveryTargetConfig({ BAKERY_DELIVERY_ENVIRONMENT: " " }),
    undefined,
  );
  assertEquals(readDeliveryTargetConfig(FULL), {
    releaseRoot: "/srv/bakery/releases",
    artifactsDir: "/srv/bakery/artifacts",
    healthUrl: "http://127.0.0.1:8000/health/ready",
    environment: "production",
  });
});

Deno.test("a partial, relative, odd-environment or non-URL set is refused, never guessed (#43)", () => {
  for (
    const broken of [
      { ...FULL, BAKERY_DELIVERY_HEALTH_URL: undefined },
      { ...FULL, BAKERY_DELIVERY_RELEASE_ROOT: "releases" },
      { ...FULL, BAKERY_DELIVERY_ARTIFACTS_DIR: "/srv/\u0000x" },
      { ...FULL, BAKERY_DELIVERY_ENVIRONMENT: "prod" },
      { ...FULL, BAKERY_DELIVERY_HEALTH_URL: "not a url" },
    ]
  ) {
    assertThrows(
      () => readDeliveryTargetConfig(broken),
      Error,
      "DELIVERY_TARGET_INVALID",
    );
  }
});
