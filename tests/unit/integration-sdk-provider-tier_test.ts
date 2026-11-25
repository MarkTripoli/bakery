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

/**
 * QA found that an optional port member silently accepted a missing port: with
 * `exactOptionalPropertyTypes` off (this repo sets no compiler options), `tickets?:
 * TicketsPort` admits `undefined`, so a manifest claiming the family compiled
 * without the port. The defect was invisible to the other tests because they only
 * asserted on values that already existed.
 *
 * These cases assert the compiler's verdict by compiling a snippet, so the guarantee
 * survives any future edit to `ServerImpl`. Without them, the only record that the
 * type works is a claim in a comment.
 */
const TYPE_PROBE_BASE = `
const base = {
  slug: "x", integrationId: "bakery.x",
  providerUuid: "12345678-1234-4123-8123-123456789012",
  nameKey: "k", appRegistration: null as null,
  connect: { kind: "api-token" as const, fields: [{ id: "t", labelKey: "k", secret: true, format: "text" as const }] },
  ingress: null as null,
  resourceKinds: [{ id: "p", nameKey: "k", serves: ["projects"] }],
};
const common = {
  connect: { probe: () => Promise.resolve({ failure: "x" }) },
  credentials: { secretSlots: ["t"], mint: () => Promise.resolve({ token: "", expiresAt: new Date(), placement: "bearer" as const }) },
  ingress: undefined,
  lifecycle: { onEvent: () => Promise.resolve() },
  discovery: { list: () => Promise.resolve({ resources: [], nextCursor: null }) },
  health: { check: () => Promise.resolve({ healthy: true as const }) },
  hostProfile: "p",
};
const ticketsPort = {
  present: () => Promise.resolve({ kind: "refused" as const, reason: "not_a_ticket" as const }),
  mutate: () => Promise.resolve({ ok: true as const }),
};
`;

/** Compiles a probe against the real SDK and returns its diagnostics. */
function typecheckProbe(body: string): { ok: boolean; output: string } {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/probe.ts`;
  Deno.writeTextFileSync(
    file,
    `import { defineServerProvider } from ${
      JSON.stringify(
        new URL(
          "../../packages/integration-sdk/provider.ts",
          import.meta.url,
        ).href,
      )
    };\n${TYPE_PROBE_BASE}\n${body}\n`,
  );
  // `--no-check` only disables checking of the *test* file itself. The probe's own
  // `deno check` must run with a private, cold cache: with the shared cache Deno can
  // reuse a previously compiled module and the probe reports success against source
  // it never re-read, which makes it unable to catch the regression it exists for.
  const result = new Deno.Command(Deno.execPath(), {
    args: ["check", "--no-lock", "--reload", file],
    env: { DENO_DIR: `${dir}/deno-dir` },
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const output = new TextDecoder().decode(result.stderr) +
    new TextDecoder().decode(result.stdout);
  return { ok: result.success, output };
}

Deno.test("a manifest that claims a family cannot omit its port (QA finding)", () => {
  // An object literal infers `families` as the tuple `["tickets"]`, where the port is
  // required even by the old optional-member shape - so this case does NOT reproduce
  // QA's report on its own. It is kept because it is the shape providers actually
  // write, and because the control below must compile. The widened form is covered by
  // the next test, which is where optionality can leak.
  const missing = typecheckProbe(
    `defineServerProvider({ ...base, families: ["tickets"] }, { ...common });`,
  );
  assert(
    !missing.ok,
    "a provider claiming tickets must not compile without the tickets port",
  );
  assert(
    missing.output.includes("tickets"),
    `the diagnostic must name the missing port, saw: ${missing.output}`,
  );
  // Control: the same provider with the port compiles, so the case above fails for
  // the reason claimed rather than for an unrelated typing mistake in the probe.
  const complete = typecheckProbe(
    `defineServerProvider({ ...base, families: ["tickets"] }, { ...common, tickets: ticketsPort });`,
  );
  assert(
    complete.ok,
    `the control case must compile, saw: ${complete.output}`,
  );
});

Deno.test("a familyless provider cannot smuggle in a family port", () => {
  const smuggled = typecheckProbe(
    `defineServerProvider({ ...base, families: [] }, { ...common, tickets: ticketsPort });`,
  );
  assert(
    !smuggled.ok,
    "an unclaimed port must be forbidden, not merely optional",
  );
});

Deno.test("the connect arm must match the connect kind", () => {
  const wrongArm = typecheckProbe(
    `defineServerProvider({ ...base, families: [] }, { ...common, connect: { begin: () => ({ steps: [] }), complete: () => Promise.resolve({ failure: "x" }) } });`,
  );
  assert(
    !wrongArm.ok,
    "an api-token provider must not accept a ConnectStrategy",
  );
  assert(
    wrongArm.output.includes("ApiTokenProbe"),
    `the diagnostic must name the required arm, saw: ${wrongArm.output}`,
  );
});

Deno.test("a provider with no ingress cannot supply one", () => {
  const extra = typecheckProbe(
    `defineServerProvider({ ...base, families: [] }, { ...common, ingress: { maxBodyBytes: 10, verify: () => ({ ok: false as const, reason: "signature" as const }), classify: () => ({ kind: "ignored" as const }) } });`,
  );
  assert(!extra.ok, "ingress: null must forbid an ingress implementation");
});

/**
 * QA's round-2 requirement, and the part of her report that closes it: a must-PASS
 * control, because a set of must-fail probes only answers "did the fix take", never
 * "did the fix overshoot".
 *
 * The control she asked for - a `ProviderManifest`-annotated familyless manifest that
 * compiles with no ports - is not expressible: that annotation widens `families` to
 * `("tickets" | "code")[]`, where `[]` and `["tickets"]` produce type-identical
 * `ServerImpl`s. Two type-identical impls cannot be accepted and rejected by one
 * conditional, so the type requires every possible port (safe: a missing port fails
 * the build) and the exact rule is enforced at runtime by `serverProviderDefects`.
 *
 * Both halves are asserted below, so neither can be silently dropped.
 */
Deno.test("a wide-annotated manifest requires every port at the type level", () => {
  // The safe default: a manifest that MIGHT claim a family must supply the port. This
  // is the arm a familyless value also lands in, which is why the runtime check below
  // exists rather than a cleverer conditional.
  //
  // The assertion names `tickets` specifically. A bare `!probe.ok` would pass for the
  // wrong reason: a wide manifest also fails on `ingress`, so a polarity flip in the
  // family rule would go unseen - the same must-fail-only weakness QA flagged.
  const probe = typecheckProbe(
    `declare const wide: ProviderManifest;
     defineServerProvider(wide, { ...common });`,
  );
  assert(
    !probe.ok,
    "a wide-annotated manifest must not compile without its ports",
  );
  assert(
    /Property 'tickets' is missing/.test(probe.output),
    `the diagnostic must name the family port, not only ingress; saw: ${probe.output}`,
  );
});

Deno.test("at runtime a familyless provider with no ports is complete, not refused", () => {
  // The must-pass half: the value is known here, so the familyless provider is
  // accepted. Reference behaviour for the runtime rule.
  const manifest: ProviderManifest = { ...testManifest(), families: [] };
  const provider = defineServerProvider(manifest, testServerImpl(manifest));
  assertEquals(serverProviderDefects(provider), []);
});

Deno.test("at runtime claiming a family without its port is refused", () => {
  const manifest: ProviderManifest = {
    ...testManifest(),
    families: ["tickets"],
  };
  // testServerImpl supplies no ports, so this is exactly claim-without-port.
  const provider = defineServerProvider(manifest, testServerImpl(manifest));
  const defects = serverProviderDefects(provider);
  assert(
    defects.some((defect) => defect.path === "impl.tickets"),
    `expected a defect naming the missing tickets port, saw ${
      JSON.stringify(defects)
    }`,
  );
});

Deno.test("at runtime supplying a port for an unclaimed family is refused", () => {
  // The overshoot direction QA warned about: a provider that declares nothing must
  // not quietly carry a port nothing will call.
  const manifest: ProviderManifest = { ...testManifest(), families: [] };
  const provider = defineServerProvider(
    manifest,
    testServerImpl(manifest, {
      tickets: {
        present: () =>
          Promise.resolve({
            kind: "refused" as const,
            reason: "not_a_ticket" as const,
          }),
        mutate: () => Promise.resolve({ ok: true as const }),
      },
    }),
  );
  assert(
    serverProviderDefects(provider).some((defect) =>
      defect.path === "impl.tickets" &&
      defect.message.includes("must not supply")
    ),
  );
});

Deno.test("ticketActions on a provider that does not serve tickets is a defect", () => {
  const ref = { id: "acme.issue.comment.create", version: 1 };
  const unserved: ProviderManifest = {
    ...testManifest({ families: [] }),
    ticketActions: { "comment.create": ref },
  };
  assert(
    manifestDefects(unserved).some((defect) =>
      defect.includes("ticketActions")
    ),
  );
  const served: ProviderManifest = {
    ...testManifest({ families: ["tickets"], ticketTriggers: ["label"] }),
    ticketActions: { "comment.create": ref },
  };
  assertEquals(
    manifestDefects(served).filter((defect) =>
      defect.includes("ticketActions")
    ),
    [],
  );
  assert(ProviderManifestSchema.safeParse(unserved).success);
  assert(
    !ProviderManifestSchema.safeParse({
      ...unserved,
      ticketActions: { "comment.delete": ref },
    }).success,
  );
});
