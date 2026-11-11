import { z } from "zod";

/** Reference manifests a ledger entry may name, mapped to their files by the architecture check. */
export const ROUTE_REFERENCE_MANIFESTS = [
  "auth",
  "enterprise",
  "settings",
  "entitlements",
  "artifacts",
] as const;

const ThemeSchema = z
  .enum(["light", "dark"])
  .describe("Color theme of the Paper frame or of the missing variant.");

const DeviceSchema = z
  .enum(["desktop", "phone"])
  .describe(
    "Device class of the Paper frame: desktop is the 1440 wide rail layout, phone is the 390 wide sheet layout.",
  );

const NonBlankSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Nonblank trimmed text; callers replace this with a field specific description.",
  );

export const RouteReferenceFrameSchema = z
  .object({
    fileId: NonBlankSchema.describe(
      "Paper file id that owns the frame; the design source of truth the golden was exported from.",
    ),
    pageId: NonBlankSchema.describe(
      "Paper page id inside the file that holds the frame.",
    ),
    frameId: NonBlankSchema.describe(
      "Paper artboard node id; matches the frameId of the baseline case that scores the route against this frame.",
    ),
    device: DeviceSchema,
    theme: ThemeSchema,
    state: NonBlankSchema.describe(
      "Route state the frame depicts, for example default or invalid; mirrors the baseline case design state.",
    ),
  })
  .strict()
  .describe(
    "One Paper artboard that depicts a production route in a single device, theme and state.",
  );

export const RouteReferenceAbsentVariantSchema = z
  .object({
    theme: ThemeSchema,
    device: DeviceSchema.optional().describe(
      "Device the missing variant would cover; omit when every device lacks the theme.",
    ),
    reason: NonBlankSchema.describe(
      "What was searched and when, so a reader can tell the variant is absent in Paper rather than forgotten.",
    ),
  })
  .strict()
  .describe(
    "A theme or device variant of the route for which Paper has no frame, recorded instead of silently skipped.",
  );

export const RouteReferenceAdditionalManifestSchema = z
  .object({
    manifest: z
      .enum(ROUTE_REFERENCE_MANIFESTS)
      .describe(
        "Another baseline manifest that also scores this route; must differ from the entry manifest and from every other additional manifest of the entry.",
      ),
    frames: z
      .array(RouteReferenceFrameSchema)
      .min(1)
      .describe(
        "Paper frames of this route that cases in the additional manifest score; each needs a listed case with its frameId.",
      ),
    cases: z
      .array(
        NonBlankSchema.describe(
          "Baseline case id inside the additional manifest.",
        ),
      )
      .min(1)
      .describe(
        "Ids of baseline cases in the additional manifest that score these frames; checked like the entry's own cases.",
      ),
  })
  .strict()
  .describe(
    "Golden cases from a second manifest that also score a baselined route, for a path whose frames live in more than one Paper source.",
  );

export const RouteReferenceStatusSchema = z
  .enum(["baselined", "planned", "no-mock", "debt"])
  .describe(
    "baselined: every frame has a passing golden case. planned: route not shipped yet, goldens exist and compare is skipped. no-mock: Paper has no frame for the route. debt: Paper has a frame but no golden yet; the debt set may only shrink.",
  );

export const RouteReferenceEntrySchema = z
  .object({
    routeId: NonBlankSchema.describe(
      "Route id exactly as declared in routeCoverage in apps/web/src/router.tsx.",
    ),
    path: z
      .string()
      .startsWith("/")
      .describe(
        "Absolute route path exactly as declared in routeCoverage, including $param segments.",
      ),
    status: RouteReferenceStatusSchema,
    rationale: NonBlankSchema.optional().describe(
      "Why the status holds; required for planned, no-mock and debt, and for no-mock and debt it must name what was searched.",
    ),
    frames: z
      .array(RouteReferenceFrameSchema)
      .describe(
        "Paper frames that depict the route; empty only when the status is no-mock.",
      ),
    absentVariants: z
      .array(RouteReferenceAbsentVariantSchema)
      .optional()
      .describe(
        "Theme or device variants Paper lacks for this route; omit when every variant exists.",
      ),
    cases: z
      .array(
        NonBlankSchema.describe("Baseline case id inside the named manifest."),
      )
      .optional()
      .describe(
        "Ids of baseline cases in the named manifest that score the frames; required for baselined and planned.",
      ),
    manifest: z
      .enum(ROUTE_REFERENCE_MANIFESTS)
      .optional()
      .describe(
        "Baseline manifest holding the cases: auth is paper-baselines.json, enterprise is enterprise-baselines.json, settings is settings-baselines.json, entitlements is entitlements-baselines.json, artifacts is artifacts-baselines.json; required for baselined and planned. Enterprise and artifacts manifests may defer scoring; entitlements may hold planned entries but not debt.",
      ),
    additionalManifests: z
      .array(RouteReferenceAdditionalManifestSchema)
      .optional()
      .describe(
        "Further manifests whose cases also score this baselined route, each with its own frames and cases; omit when one manifest holds every case.",
      ),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: "custom", message, path });
    if (entry.status !== "baselined" && !entry.rationale) {
      fail(`${entry.status} entry ${entry.routeId} needs a rationale`, [
        "rationale",
      ]);
    }
    if (entry.additionalManifests?.length) {
      if (entry.status !== "baselined") {
        fail(
          `${entry.status} entry ${entry.routeId} must not list additional manifests; only a baselined route has scored cases in several manifests`,
          ["additionalManifests"],
        );
      }
      const named = new Set<string>(entry.manifest ? [entry.manifest] : []);
      entry.additionalManifests.forEach((group, index) => {
        if (named.has(group.manifest)) {
          fail(
            `additional manifest ${group.manifest} of ${entry.routeId} repeats a manifest the entry already names`,
            ["additionalManifests", index, "manifest"],
          );
        }
        named.add(group.manifest);
      });
    }
    if (entry.status === "no-mock") {
      if (entry.frames.length) {
        fail("no-mock entry must not list frames", ["frames"]);
      }
      if (entry.cases?.length || entry.manifest) {
        fail("no-mock entry must not name cases or a manifest");
      }
      return;
    }
    if (!entry.frames.length) {
      fail(`${entry.status} entry needs at least one frame`, ["frames"]);
    }
    if (entry.status === "debt") {
      if (entry.cases?.length) {
        fail("debt entry has no golden, so no cases", ["cases"]);
      }
      return;
    }
    if (!entry.manifest) {
      fail(`${entry.status} entry must name a manifest`, ["manifest"]);
    }
    if (!entry.cases?.length) {
      fail(`${entry.status} entry must list baseline cases`, ["cases"]);
    }
    if (
      entry.status === "planned" && entry.manifest !== "enterprise" &&
      entry.manifest !== "entitlements" && entry.manifest !== "artifacts"
    ) {
      fail(
        `planned entry ${entry.routeId} must use the enterprise, entitlements, or artifacts manifest; the auth and settings manifests cannot defer scoring`,
        ["manifest"],
      );
    }
  })
  .describe(
    "Reference record for one production route: its status, the Paper frames it is judged against, and the golden cases that enforce it.",
  );

export const RouteReferenceLedgerSchema = z
  .object({
    schemaVersion: z
      .literal(1)
      .describe("Ledger format version; bump when the entry shape changes."),
    description: NonBlankSchema.optional().describe(
      "Free-text note about what the ledger tracks, ignored by the checks.",
    ),
    entries: z
      .array(RouteReferenceEntrySchema)
      .describe(
        "One entry per production route declared in routeCoverage, plus planned entries for routes that are not shipped yet.",
      )
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          if (seen.has(entry.routeId)) {
            ctx.addIssue({
              code: "custom",
              message: `duplicate ledger entry for route ${entry.routeId}`,
              path: [index, "routeId"],
            });
          }
          seen.add(entry.routeId);
        });
      })
      .describe(
        "One entry per production route declared in routeCoverage, plus planned entries for routes that are not shipped yet; route ids are unique.",
      ),
  })
  .strict()
  .describe(
    "Route reference ledger: links each production route to the approved Paper frames and golden cases that judge it.",
  );

export type RouteReferenceEntry = z.infer<typeof RouteReferenceEntrySchema>;
export type RouteReferenceLedger = z.infer<typeof RouteReferenceLedgerSchema>;

export type RouteReferenceParse =
  | { success: true; ledger: RouteReferenceLedger }
  | { success: false; issues: string[] };

/** Parses ledger JSON; failures come back as flat `path: message` strings. */
export function parseRouteReferenceLedger(value: unknown): RouteReferenceParse {
  const result = RouteReferenceLedgerSchema.safeParse(value);
  if (result.success) return { success: true, ledger: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) =>
      `${issue.path.join(".") || "(root)"}: ${issue.message}`
    ),
  };
}
