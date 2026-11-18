import { assert, assertEquals } from "@std/assert";
import {
  credentialFieldAccepts,
  credentialFieldDefects,
  defineServerProvider,
  manifestDefects,
  ProviderManifestSchema,
  RESERVED_PROVIDER_SLUGS,
  serverProviderDefects,
  TICKET_ADMISSION_REFUSALS,
} from "../../packages/integration-sdk/provider.ts";
import {
  defineWebProvider,
  webProviderDefects,
} from "../../packages/integration-sdk/web.ts";
import type { ProviderManifest } from "../../packages/integration-sdk/provider.ts";
import {
  fakeDriverContext,
  fakeTransport,
  testManifest,
  testServerImpl,
} from "../../packages/integration-sdk/testing.ts";

/**
 * Slice 2 ships types and no callers, so these tests are the only thing standing
 * between a wrong port shape and slice 5 discovering it. Each case names the
 * mistake a provider author would actually make.
 */

const githubManifest: ProviderManifest = {
  slug: "github",
  integrationId: "bakery.github",
  providerUuid: "11111111-1111-4111-8111-111111111111",
  nameKey: "integrations.github.name",
  families: ["tickets", "code"],
  appRegistration: { kind: "github-manifest" },
  connect: { kind: "github-app" },
  ingress: { scope: "app" },
  resourceKinds: [{
    id: "repository",
    nameKey: "integrations.github.kinds.repository",
    serves: ["projects", "changes"],
  }],
};

Deno.test("a valid manifest parses and a malformed one does not", () => {
  assertEquals(ProviderManifestSchema.safeParse(githubManifest).success, true);
  // A connect kind outside the closed union is refused rather than stored, so a
  // typo cannot become a provider nobody can connect.
  assertEquals(
    ProviderManifestSchema.safeParse({
      ...githubManifest,
      connect: { kind: "saml" },
    }).success,
    false,
  );
  // `chat` is deliberately not a family yet.
  assertEquals(
    ProviderManifestSchema.safeParse({
      ...githubManifest,
      families: ["chat"],
    }).success,
    false,
  );
  // An ingress must be a scope or null, not an empty object.
  assertEquals(
    ProviderManifestSchema.safeParse({ ...githubManifest, ingress: {} })
      .success,
    false,
  );
});

Deno.test("a reserved slug and a mismatched integration id are refused", () => {
  const reserved = testManifest({ slug: "settings" });
  assert(
    manifestDefects(reserved).some((defect) => defect.includes("reserved")),
    "settings is a route, so it must not be a provider slug",
  );
  for (const slug of RESERVED_PROVIDER_SLUGS) {
    assert(
      manifestDefects(testManifest({ slug })).some((defect) =>
        defect.includes("reserved")
      ),
      slug,
    );
  }
  // The gate routes by integrationId, so both halves must name the same provider.
  const mismatched: ProviderManifest = {
    ...testManifest(),
    integrationId: "bakery.gitlab",
  };
  assert(
    manifestDefects(mismatched).some((defect) =>
      defect.includes("bakery.<slug>")
    ),
  );
});

Deno.test("a repeated family or resource kind is a defect, not a silent dedupe", () => {
  assert(
    manifestDefects({
      ...githubManifest,
      families: ["tickets", "tickets"],
    }).some((defect) => defect.includes("families")),
  );
  assert(
    manifestDefects({
      ...githubManifest,
      resourceKinds: [
        githubManifest.resourceKinds[0]!,
        githubManifest.resourceKinds[0]!,
      ],
    }).some((defect) => defect.includes("kind id")),
  );
});

Deno.test("the credential strategy cannot mint from a slot nothing collects", () => {
  // A strategy that asks for a secret the manifest never asks a person for would
  // fail at the first mint, in production, on a real connection.
  const impl = testServerImpl(githubManifest, {
    credentials: {
      secretSlots: ["token", "privateKey"],
      mint: () =>
        Promise.resolve({
          token: "t",
          expiresAt: new Date(),
          placement: "bearer" as const,
        }),
    },
  });
  const provider = defineServerProvider(githubManifest, impl);
  const defects = serverProviderDefects(provider);
  assert(
    defects.some((defect) => defect.message.includes("privateKey")),
    `expected a defect naming the uncollected slot, saw ${
      JSON.stringify(defects)
    }`,
  );
});

Deno.test("a provider that serves a family must declare a resource kind", () => {
  const manifest: ProviderManifest = { ...githubManifest, resourceKinds: [] };
  const provider = defineServerProvider(manifest, testServerImpl(manifest));
  assert(
    serverProviderDefects(provider).some((defect) =>
      defect.path === "manifest.resourceKinds"
    ),
  );
});

Deno.test("an empty host profile is refused", () => {
  const provider = defineServerProvider(
    githubManifest,
    testServerImpl(githubManifest, { hostProfile: "  " }),
  );
  assert(
    serverProviderDefects(provider).some((defect) =>
      defect.path === "impl.hostProfile"
    ),
  );
});

Deno.test("defineServerProvider carries the manifest so the host never imports one", () => {
  const provider = defineServerProvider(
    githubManifest,
    testServerImpl(githubManifest),
  );
  assertEquals(provider.kind, "server-provider");
  assertEquals(provider.manifest.slug, "github");
  // Frozen, so a caller cannot mutate a manifest another part of the host is
  // routing by.
  assert(Object.isFrozen(provider));
  assert(Object.isFrozen(provider.manifest));
});

Deno.test("a github-app provider must bring a ConnectStep and others must not", () => {
  const step = () => null;
  assertEquals(
    webProviderDefects(
      defineWebProvider({ manifest: githubManifest, ConnectStep: step }),
    ),
    [],
  );
  assert(
    webProviderDefects(
      defineWebProvider({ manifest: githubManifest, ConnectStep: undefined }),
    ).some((defect) => defect.includes("ConnectStep")),
  );
  // An api-token provider is connected by core, so a step here would be a second
  // implementation of the same flow.
  const tokenManifest = testManifest();
  assertEquals(
    webProviderDefects(
      defineWebProvider({ manifest: tokenManifest, ConnectStep: undefined }),
    ),
    [],
  );
  assert(
    webProviderDefects(
      defineWebProvider({ manifest: tokenManifest, ConnectStep: step }),
    ).some((defect) => defect.includes("must not export ConnectStep")),
  );
});

Deno.test("credential field formats are shared, not re-implemented per provider", () => {
  const text = {
    id: "t",
    labelKey: "k",
    secret: true,
    format: "text",
  } as const;
  const email = {
    id: "e",
    labelKey: "k",
    secret: false,
    format: "email",
  } as const;
  const origin = {
    id: "o",
    labelKey: "k",
    secret: false,
    format: "https-origin",
  } as const;
  assertEquals(credentialFieldAccepts(text, "anything"), true);
  assertEquals(credentialFieldAccepts(text, "   "), false);
  assertEquals(credentialFieldAccepts(email, "a@b.co"), true);
  assertEquals(credentialFieldAccepts(email, "not-an-address"), false);
  assertEquals(credentialFieldAccepts(origin, "https://api.example.com"), true);
  // An origin, not a URL: a path would let the caller influence the request target
  // the host binds every request to.
  assertEquals(
    credentialFieldAccepts(origin, "https://api.example.com/v3"),
    false,
  );
  assertEquals(credentialFieldAccepts(origin, "http://api.example.com"), false);
  assertEquals(
    credentialFieldAccepts(origin, "https://user:pw@api.example.com"),
    false,
  );
  assertEquals(credentialFieldDefects([text, { ...text }]), [
    "The credential field t is declared twice.",
  ]);
});

Deno.test("the ticket refusal vocabulary is closed and keeps today's reason", () => {
  // Section 12: a GitHub pull request arrives as not_a_ticket, and the lift maps it
  // back to today's reason code. Removing it here would silently change the engine.
  assert(TICKET_ADMISSION_REFUSALS.includes("not_a_ticket"));
  assertEquals(
    new Set(TICKET_ADMISSION_REFUSALS).size,
    TICKET_ADMISSION_REFUSALS.length,
  );
});

Deno.test("the fake transport records requests and fails on an unqueued one", async () => {
  const transport = fakeTransport([{ body: '{"ok":true}' }]);
  const response = await transport.send({
    method: "GET",
    path: "/repos/o/r",
    maxResponseBytes: 1024,
  });
  assertEquals(response.status, 200);
  assertEquals(new TextDecoder().decode(response.body), '{"ok":true}');
  assertEquals(transport.requests[0]?.path, "/repos/o/r");
  assertEquals(transport.pending, 0);
  // A provider that calls an endpoint its own test did not anticipate is a defect,
  // so the double fails loudly instead of returning an empty body.
  await assertRejects(
    () =>
      transport.send({ method: "GET", path: "/extra", maxResponseBytes: 1 }),
    "queued no further response",
  );
});

Deno.test("the fake driver context fixes the clock and can be aborted", () => {
  const driver = fakeDriverContext({ now: new Date("2026-05-05T00:00:00Z") });
  assertEquals(driver.ctx.now().toISOString(), "2026-05-05T00:00:00.000Z");
  assertEquals(driver.ctx.signal.aborted, false);
  driver.abort("timeout");
  assertEquals(driver.aborted, true);
  assertEquals(driver.ctx.signal.aborted, true);
});

Deno.test("the test manifest defaults to a shape a real provider can have", () => {
  const manifest = testManifest();
  assertEquals(manifestDefects(manifest), []);
  assertEquals(ProviderManifestSchema.safeParse(manifest).success, true);
  // api-token connect is the default because it needs the least host machinery.
  assertEquals(manifest.connect.kind, "api-token");
});

async function assertRejects(
  fn: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(expected),
      `expected an error containing ${expected}, saw ${error}`,
    );
    return;
  }
  throw new Error(`expected a rejection containing ${expected}`);
}
