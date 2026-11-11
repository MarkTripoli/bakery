import { assertEquals } from "@std/assert";
import { orgHeader } from "./account-settings.ts";
import { authTestOrigin } from "./auth.ts";
import { call, type InstallationFixture } from "./installation-settings.ts";

export type Json = Record<string, unknown>;

/** Admin REST call with the organization header and a fresh idempotency key. */
export async function adminJson(
  f: InstallationFixture,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return await call(f, method, path, f.adminCookie, {
    body,
    headers: {
      ...orgHeader(f.organizationId),
      "Idempotency-Key": crypto.randomUUID(),
      ...headers,
    },
  });
}

/** A bearer-token request: no cookie, no Origin header. */
export function bearerCall(
  f: InstallationFixture,
  method: string,
  path: string,
  secret: string,
  options: {
    organizationId?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${secret}`);
  const organizationId = options.organizationId === undefined
    ? f.organizationId
    : options.organizationId;
  if (organizationId !== null) {
    headers.set("Bakery-Organization-Id", organizationId);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET") headers.set("Idempotency-Key", crypto.randomUUID());
  return f.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    }),
  );
}

export async function createServiceAccount(
  f: InstallationFixture,
  displayName: string,
  role: string | null,
) {
  const response = await adminJson(f, "POST", "/v1/principals", {
    displayName,
    role,
  });
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as Json & { id: string; version: number };
}

export async function mintToken(
  f: InstallationFixture,
  principalId: string | undefined,
  scopes: string[],
  name = "test token",
) {
  const response = await adminJson(f, "POST", "/v1/access-tokens", {
    ...(principalId === undefined ? {} : { principalId }),
    name,
    scopes,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as Json & {
    id: string;
    secret: string;
    version: number;
  };
}
