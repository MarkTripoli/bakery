/**
 * Build-time names the web build reads while Vite runs. None of them reaches a
 * browser bundle or a runtime process: `SENTRY_AUTH_TOKEN` is a secret and the
 * other three only describe the upload. Railway hands a Dockerfile build its
 * service variables through `ARG` and nothing else, so each name here needs a
 * matching declaration in `apps/web/Dockerfile`; the rail in
 * `tests/rails/railway-deploy-assets_test.ts` ties the two lists together so a
 * new build variable cannot go undeclared and silently absent.
 */
export const SENTRY_WEB_BUILD_ENVIRONMENT_NAMES = [
  "SENTRY_UPLOAD_SOURCEMAPS",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
] as const;

/** The only accepted upload declarations; absence is not one of them. */
const uploadDeclarations = ["true", "false", "1", "0"] as const;

/**
 * Whether an instrumented web build uploads source maps.
 *
 * Upload used to be derived from telemetry being enabled, which made the Sentry
 * organization auth token mandatory for any browser reporting at all: there was
 * no way to express "report browser errors, do not upload source maps", so a
 * deployment that holds a DSN but no token could not report anything (#353,
 * #523). Upload is now declared, and only declared: an absent or unrecognised
 * `SENTRY_UPLOAD_SOURCEMAPS` fails the build rather than defaulting to off,
 * because a default-off would reintroduce exactly the silent miss that the
 * `ARG` rails exist to prevent — a production build would ship minified frames
 * and report success.
 *
 * A build that is not instrumented (telemetry disabled, or Vite serving rather
 * than building) uploads nothing and needs no declaration, so an ordinary
 * `docker build` and local development stay untouched.
 */
export function readSentrySourcemapUpload(
  env: Readonly<Record<string, string | undefined>>,
  instrumentedBuild: boolean,
): boolean {
  if (!instrumentedBuild) return false;
  const [declarationName, organizationName, projectName, tokenName] =
    SENTRY_WEB_BUILD_ENVIRONMENT_NAMES;
  const declared = env[declarationName]?.trim();
  if (!declared) throw new Error("SENTRY_BUILD_UPLOAD_DECISION_REQUIRED");
  if (!(uploadDeclarations as readonly string[]).includes(declared)) {
    throw new Error("SENTRY_BUILD_UPLOAD_DECISION_INVALID");
  }
  if (declared === "false" || declared === "0") return false;
  // Upload declared on: the plugin needs the whole target, and a build that
  // claims to upload and then cannot would publish a release with no maps.
  if (!env[tokenName]?.trim()) {
    throw new Error("SENTRY_BUILD_AUTH_TOKEN_REQUIRED");
  }
  if (!env[organizationName]?.trim() || !env[projectName]?.trim()) {
    throw new Error("SENTRY_BUILD_TARGET_REQUIRED");
  }
  return true;
}
