import type { Context, Next } from "hono";
import { z } from "zod";
import { problemResponse } from "@bakery/contracts/http";

const PathIdSchema = z.string().uuid().describe(
  "A path segment that names a machine, enrollment or one of their records by UUID.",
);
const PathParamSchema = z.string().describe(
  "The route parameter a path segment fills, such as id or bindingId.",
);
const PathIdsSchema = z.record(PathParamSchema, PathIdSchema).describe(
  "Every id a machine or enrollment route path names, keyed by its route parameter.",
);
const ID_PREFIXES: readonly (readonly [string, string])[] = [
  ["/v1/workers/", "id"],
  ["/v1/worker-enrollments/", "id"],
];
const NESTED_COLLECTIONS: Readonly<Record<string, string>> = {
  "maintenance": "operationId",
  "provider-bindings": "bindingId",
  "auth-attempts": "authAttemptId",
};

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function malformedPathIds(path: string): z.ZodError | null {
  const prefix = ID_PREFIXES.find(([start]) => path.startsWith(start));
  if (prefix === undefined) return null;
  const segments = path.slice(prefix[0].length).split("/");
  const named: Record<string, string> = {};
  if (segments[0] !== undefined) named[prefix[1]] = segments[0];
  segments.forEach((segment, index) => {
    const param = NESTED_COLLECTIONS[segment];
    const value = segments[index + 1];
    if (param !== undefined && value !== undefined) named[param] = value;
  });
  const parsed = PathIdsSchema.safeParse(
    Object.fromEntries(
      Object.entries(named).map(([param, value]) => [param, decoded(value)]),
    ),
  );
  return parsed.success ? null : parsed.error;
}

export function rejectMalformedWorkerIds(publicBaseUrl: string) {
  return async (context: Context, next: Next): Promise<Response | void> => {
    const invalid = malformedPathIds(context.req.path);
    if (invalid === null) return await next();
    return problemResponse(context, invalid, { publicBaseUrl });
  };
}
