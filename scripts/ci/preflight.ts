const lane = Deno.args[0];
const authorization = Deno.env.get("BAKERY_LANE_AUTHORIZED");
const manifest = Deno.env.get("BAKERY_PREREQUISITE_MANIFEST");
if (!lane || !["connected", "native", "r2"].includes(lane)) {
  console.error("Usage: preflight.ts connected|native|r2");
  Deno.exit(2);
}
if (authorization !== "true") {
  console.error(
    `${lane} lane blocked: BAKERY_LANE_AUTHORIZED=true is required`,
  );
  Deno.exit(78);
}
if (!manifest || !manifest.trim() || manifest.includes("..")) {
  console.error(
    `${lane} lane blocked: a bounded prerequisite manifest is required`,
  );
  Deno.exit(78);
}
const info = await Deno.stat(manifest).catch(() => null);
if (!info?.isFile || !manifest.endsWith(".json")) {
  console.error(`${lane} lane blocked: prerequisite manifest is missing`);
  Deno.exit(78);
}
const document = await Deno.readTextFile(manifest).then(JSON.parse).catch(() =>
  null
) as
  | {
    lane?: string;
    authority?: string;
    resources?: unknown[];
    cleanup?: string;
  }
  | null;
if (
  !document || document.lane !== lane || document.authority !== "explicit" ||
  !Array.isArray(document.resources) || document.resources.length === 0 ||
  !document.resources.every((resource) =>
    typeof resource === "string" && resource === resource.trim() &&
    /^[A-Za-z0-9._:/ -]{1,200}$/.test(resource)
  ) ||
  typeof document.cleanup !== "string" ||
  document.cleanup !== document.cleanup.trim() ||
  !/^[A-Za-z0-9._:/ -]{8,200}$/.test(document.cleanup)
) {
  console.error(
    `${lane} lane blocked: manifest must declare matching lane, explicit authority, resources, and cleanup`,
  );
  Deno.exit(78);
}
console.log(
  `${lane} lane prerequisites verified; secrets and manifest contents are redacted`,
);
