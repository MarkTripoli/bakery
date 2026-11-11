import { z } from "zod";

const NonBlankSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Nonblank trimmed text; callers replace this with a field specific description.",
  );

const PositiveIntSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "Positive whole number of CSS pixels; callers replace this with a field specific description.",
  );

/**
 * Device chrome a Paper device frame draws around the product UI, for example
 * an iOS status bar. A web app never renders it, so the candidate is captured
 * `top` rows shorter and the reference loses its top `top` rows.
 */
export const DeviceChromeSchema = z
  .object({
    top: PositiveIntSchema.describe(
      "Height in CSS pixels of the device chrome band at the top of the Paper reference. The candidate is captured at a W by (H - top) viewport, because a web app renders no device chrome, and is compared whole against the reference rows [top, H); a candidate of any other size fails. Must be smaller than the artboard height, and must equal the measured height of the status bar element in the rendered reference; the reference check fails on drift.",
    ),
    reason: NonBlankSchema.describe(
      "Why this band is excluded, naming the chrome and why the app never draws it, so a reader can tell the exclusion is design chrome rather than a hidden defect.",
    ),
    source: z
      .object({
        frameId: NonBlankSchema.describe(
          "Paper artboard node id of the frame whose first child draws the chrome; matches the case frameId.",
        ),
        nodeId: NonBlankSchema.optional().describe(
          "Paper node id of the chrome element itself when Paper exposes one; omit when the source JSX carries no id for it.",
        ),
      })
      .strict()
      .describe(
        "Where in the Paper source the chrome is drawn, so the band can be re-measured.",
      ),
  })
  .strict()
  .describe(
    "Paper device chrome excluded from a phone design case: the reference's top band of rows is cropped before scoring and the candidate is captured at a viewport `top` rows shorter, so no chrome is drawn. Enterprise cases only; auth and worker-readiness cases never carry it.",
  );

export type DeviceChrome = z.infer<typeof DeviceChromeSchema>;

const SizeSchema = z
  .object({
    width: PositiveIntSchema.describe("Width in CSS pixels."),
    height: PositiveIntSchema.describe("Height in CSS pixels."),
  })
  .strict()
  .describe("A width and height in CSS pixels.");

const RouteCandidateSchema = z
  .object({
    route: z
      .string()
      .startsWith("/")
      .describe("App route the candidate is captured from."),
    session: z
      .enum(["anonymous", "authenticated"])
      .describe("Session the candidate route is captured under."),
  })
  .strict()
  .describe("An app route candidate: the page at this route is captured.");

const StoryArgValueSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .describe("Story arg value; a finite identifier string.");

/**
 * A Storybook story candidate captured by its whole-artboard element, with the
 * same semantics as the K-0 whole-artboard contract: the qualification region
 * must be visible above the artboard, and only the artboard element is scored.
 */
export const StoryCandidateSchema = z
  .object({
    storyId: NonBlankSchema.describe(
      "Storybook story id rendered from the built Storybook, for example bakery-templates-workerreadonlydetail--contract.",
    ),
    args: z
      .record(
        z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
          .describe("Story arg name; an identifier."),
        StoryArgValueSchema,
      )
      .describe("Story args passed in the story URL, for example state ready."),
    reducedMotion: z
      .enum(["reduce", "no-preference"])
      .describe(
        "Reduced-motion preference of the story capture; matches the runtime context the paired light case uses.",
      ),
    wholeArtboard: z
      .object({
        targetSelector: NonBlankSchema.describe(
          "Selector of the one element that draws the whole artboard; its box must equal the artboard size and is the only area scored.",
        ),
        qualificationSelector: NonBlankSchema.describe(
          "Selector of the qualification region that must be visible, accessible and above the artboard when the capture is taken.",
        ),
      })
      .strict()
      .describe(
        "Whole-artboard element capture: which element is the artwork and which region qualifies it.",
      ),
  })
  .strict()
  .describe(
    "A Storybook story candidate scored by its whole-artboard element, the way the K-0 detail cases are scored, for a reference that is a render rather than a Paper export.",
  );

export const EnterpriseDesignCaseSchema = z
  .object({
    id: NonBlankSchema.describe(
      "Case id of the form screen.state.theme.device, unique within the manifest.",
    ),
    reference: z
      .literal("design")
      .describe("Enterprise cases are all design references."),
    frameId: NonBlankSchema.describe(
      "Paper artboard node id the reference was exported from.",
    ),
    pageId: NonBlankSchema.describe(
      "Paper page id that holds the artboard.",
    ),
    design: z
      .object({
        screen: NonBlankSchema.describe(
          "Screen id in the Paper source manifest.",
        ),
        state: NonBlankSchema.describe("Screen state, for example default."),
        theme: z.enum(["light", "dark"]).describe("Color theme of the frame."),
        device: z
          .enum(["desktop", "phone"])
          .describe("Device class of the frame."),
      })
      .strict()
      .describe("The screen, state, theme and device tuple of the frame."),
    imagePath: NonBlankSchema.describe(
      "Repository path of the committed reference PNG.",
    ),
    imageSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("SHA-256 of the committed reference PNG bytes."),
    viewport: SizeSchema.describe(
      "Viewport the reference and the candidate are rendered at; the Paper frame size.",
    ),
    artboard: SizeSchema.describe("Paper artboard size."),
    image: SizeSchema.describe("Pixel size of the committed reference PNG."),
    dpr: PositiveIntSchema.describe("Device pixel ratio of the render."),
    theme: z.enum(["light", "dark"]).describe("Color theme of the render."),
    pointer: z
      .enum(["fine", "coarse"])
      .describe("Primary pointer the render emulates."),
    locale: NonBlankSchema.describe("Locale of the render."),
    direction: z.enum(["ltr", "rtl"]).describe("Text direction of the render."),
    browser: NonBlankSchema.describe("Browser engine of the render."),
    os: NonBlankSchema.describe("Platform the reference was rendered on."),
    fontDigests: z
      .record(
        z.string().describe("Repository path of the font file."),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .describe("SHA-256 of the font file bytes."),
      )
      .describe("SHA-256 of every font file that rendered the reference text."),
    candidate: z
      .union([RouteCandidateSchema, StoryCandidateSchema])
      .describe(
        "Where the app renders this case: an app route, or a Storybook story scored by its whole-artboard element.",
      ),
    deviceChrome: DeviceChromeSchema.optional().describe(
      "Optional device chrome band excluded from the comparison; phone cases only. Mutually exclusive with comparisonRegion.",
    ),
    comparisonRegion: z
      .object({
        x: z.number().int().nonnegative().describe("Left edge in CSS pixels."),
        y: z.number().int().nonnegative().describe("Top edge in CSS pixels."),
        width: PositiveIntSchema.describe("Region width in CSS pixels."),
        height: PositiveIntSchema.describe("Region height in CSS pixels."),
        candidateOrigin: z
          .literal("main")
          .optional()
          .describe(
            "When \"main\", the region is the design's content box and the candidate is the app's <main> box, which must be the same size; the shell around each is not scored.",
          ),
        measure: NonBlankSchema.optional().describe(
          "CSS selector whose page box the reference render measures to fill the region; omit for a hand-declared rectangle.",
        ),
      })
      .strict()
      .optional()
      .describe(
        "Optional sub-rectangle to compare, optionally anchored to the app's <main> box. Mutually exclusive with deviceChrome: the deviceChrome comparison branch ignores it.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if ("storyId" in value.candidate) {
      // The whole-artboard element is the comparison: no band or region may
      // narrow it.
      for (const field of ["deviceChrome", "comparisonRegion"] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message:
              `a story candidate is scored by its whole-artboard element; ${field} is not allowed`,
          });
        }
      }
    }
    const chrome = value.deviceChrome;
    if (!chrome) return;
    if (value.comparisonRegion !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["comparisonRegion"],
        message:
          "deviceChrome and comparisonRegion are mutually exclusive: the chrome band branch ignores comparisonRegion",
      });
    }
    if (value.design.device !== "phone") {
      context.addIssue({
        code: "custom",
        path: ["deviceChrome"],
        message: "deviceChrome applies to phone cases only",
      });
    }
    if (chrome.top >= value.artboard.height) {
      context.addIssue({
        code: "custom",
        path: ["deviceChrome", "top"],
        message:
          `deviceChrome.top ${chrome.top} must be smaller than the artboard height ${value.artboard.height}`,
      });
    }
    if (chrome.source.frameId !== value.frameId) {
      context.addIssue({
        code: "custom",
        path: ["deviceChrome", "source", "frameId"],
        message:
          `deviceChrome.source.frameId ${chrome.source.frameId} must equal the case frameId ${value.frameId}`,
      });
    }
  })
  .describe(
    "One enterprise Paper design case: a committed reference PNG, the frame it came from, and the route that must match it.",
  );

export type EnterpriseDesignCase = z.infer<typeof EnterpriseDesignCaseSchema>;

export const EnterpriseBaselinesSchema = z
  .object({
    schemaVersion: z.literal(2).describe("Manifest schema version."),
    source: z
      .looseObject({})
      .describe(
        "Paper source identity (file, page, inputs, digest); validated by the reference check, not by this schema.",
      ),
    reference: z
      .looseObject({})
      .describe("Reference render overrides; empty for the enterprise site."),
    excluded: z
      .array(z.unknown().describe("One excluded artboard record."))
      .describe("Artboards deliberately left out of the manifest."),
    cases: z
      .array(EnterpriseDesignCaseSchema)
      .describe("Every enterprise design case."),
  })
  .strict()
  .describe(
    "enterprise-baselines.json: the Paper design cases the enterprise route goldens are scored against.",
  );

export type EnterpriseBaselines = z.infer<typeof EnterpriseBaselinesSchema>;

/** Validates an enterprise baselines manifest; returns readable issues instead of throwing. */
export function parseEnterpriseBaselines(
  value: unknown,
): { success: true; data: EnterpriseBaselines } | {
  success: false;
  issues: string[];
} {
  const result = EnterpriseBaselinesSchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) =>
      `${issue.path.join(".") || "(root)"}: ${issue.message}`
    ),
  };
}
