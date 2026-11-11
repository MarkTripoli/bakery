import { assertEquals } from "@std/assert";
import { createAuthRoutes } from "../../apps/server/src/modules/auth/transport/http/routes.ts";
import {
  AuthProblemCode,
  problemResponse,
  StandardError,
  toProblem,
} from "../../packages/contracts/src/http.ts";

Deno.test("AUTH_FACTOR_REQUIRED renders a bounded problem+json envelope", () => {
  const problem = toProblem(
    new StandardError({ code: AuthProblemCode.FactorRequired }),
    {
      requestId: "totp-contract-request",
      traceId: "totp-contract-trace",
      publicBaseUrl: "https://bakery.example.test",
    },
  );
  assertEquals(problem.status, 401);
  assertEquals(problem.code, "AUTH_FACTOR_REQUIRED");
  assertEquals(problem.type.endsWith("auth-factor-required"), true);
});

Deno.test("the /api/auth/* passthrough strips a client-supplied remote-address header and sets it from the connection", async () => {
  let captured: Request | undefined;
  const app = createAuthRoutes({
    auth: {
      handler(request) {
        captured = request;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      api: {
        getSession: () => Promise.resolve(null),
      },
    },
    database: {} as never,
    store: {
      loadEnabledPrincipal: () => Promise.resolve(null),
      findSessionState: () => Promise.resolve(null),
    } as never,
    publicBaseUrl: "http://127.0.0.1:8788",
    trustedOrigins: ["http://127.0.0.1:8788"],
    secret: "a".repeat(32),
  });

  const request = new Request(
    "http://127.0.0.1:8788/api/auth/get-session",
    { headers: { "x-bakery-remote-addr": "client-spoofed" } },
  );
  await app.fetch(request, {
    remoteAddr: { transport: "tcp", hostname: "192.0.2.9", port: 1 },
  });
  if (!captured) {
    throw new Error("passthrough never invoked the provider handler");
  }
  assertEquals(captured.headers.get("x-bakery-remote-addr"), "192.0.2.9");
});

Deno.test("provider responses at or above 500 collapse to a standard problem body", async () => {
  const app = createAuthRoutes({
    auth: {
      handler: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ message: "decrypt failed: totp-secret-detail" }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
        ),
      api: { getSession: () => Promise.resolve(null) },
    },
    database: {} as never,
    store: {
      loadEnabledPrincipal: () => Promise.resolve(null),
      findSessionState: () => Promise.resolve(null),
    } as never,
    publicBaseUrl: "http://127.0.0.1:8788",
    trustedOrigins: ["http://127.0.0.1:8788"],
    secret: "a".repeat(32),
  });
  // Mirrors the root `app.onError` wiring in `apps/server/src/app.ts`.
  app.onError((error, context) =>
    problemResponse(context, error, {
      publicBaseUrl: "http://127.0.0.1:8788",
    })
  );

  const response = await app.fetch(
    new Request("http://127.0.0.1:8788/api/auth/two-factor/verify-totp"),
  );
  assertEquals(response.status, 500);
  assertEquals(
    response.headers.get("content-type"),
    "application/problem+json",
  );
  assertEquals(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as {
    code: string;
    status: number;
    retryable: boolean;
  };
  assertEquals(body.code, "INTERNAL");
  assertEquals(body.status, 500);
  assertEquals(body.retryable, false);
});
