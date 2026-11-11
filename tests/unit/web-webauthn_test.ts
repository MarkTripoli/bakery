import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  base64urlToBuffer,
  bufferToBase64url,
  classifyWebAuthnError,
  createPasskeyCredential,
  type CredentialsContainerLike,
  decodeCreationOptions,
  decodeRequestOptions,
  getPasskeyAssertion,
  WebAuthnCeremonyError,
} from "../../apps/web/src/app/webauthn.ts";

function bytes(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)];
}

function bufferOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

Deno.test("base64url round-trips every padding length without padding", () => {
  for (const sample of [[], [251], [251, 255], [251, 255, 190], [0, 1, 2, 3]]) {
    const encoded = bufferToBase64url(bufferOf(...sample));
    assert(!encoded.includes("="), "no padding");
    assert(!/[+/]/.test(encoded), "url-safe alphabet");
    assertEquals(bytes(base64urlToBuffer(encoded)), sample);
  }
  assertEquals(bufferToBase64url(bufferOf(251, 255, 190)), "-_--");
  // Padded input is tolerated on decode.
  assertEquals(bytes(base64urlToBuffer("-_8=")), [251, 255]);
});

Deno.test("creation options decode challenge, user.id and excludeCredentials ids", () => {
  const decoded = decodeCreationOptions({
    challenge: "AQID",
    rp: { name: "Bakery" },
    user: { id: "BAUG", name: "alex@example.com", displayName: "Alex" },
    excludeCredentials: [
      { id: "BwgJ", type: "public-key", transports: ["internal"] },
      { id: "CgsM" },
    ],
  });
  assertEquals(bytes(decoded.challenge), [1, 2, 3]);
  assertEquals(bytes(decoded.user.id), [4, 5, 6]);
  assertEquals(decoded.user.name, "alex@example.com");
  assertEquals(decoded.rp, { name: "Bakery" });
  assertEquals(
    decoded.excludeCredentials?.map((entry) => bytes(entry.id)),
    [[7, 8, 9], [10, 11, 12]],
  );
  assertEquals(decoded.excludeCredentials?.[0].transports, ["internal"]);
  assertEquals(decoded.excludeCredentials?.[1].type, "public-key");
});

Deno.test("request options decode challenge and allowCredentials ids", () => {
  const decoded = decodeRequestOptions({
    challenge: "AQID",
    allowCredentials: [{ id: "BwgJ", type: "public-key" }],
    userVerification: "preferred",
  });
  assertEquals(bytes(decoded.challenge), [1, 2, 3]);
  assertEquals(
    decoded.allowCredentials?.map((entry) => bytes(entry.id)),
    [[7, 8, 9]],
  );
  assertEquals(decoded.userVerification, "preferred");
  assertEquals(
    decodeRequestOptions({ challenge: "AQID" }).allowCredentials,
    undefined,
  );
});

function fakeCredential(transports: string[] | null) {
  const response: Record<string, unknown> = {
    clientDataJSON: bufferOf(1, 2),
    attestationObject: bufferOf(3, 4, 5),
  };
  if (transports !== null) response.getTransports = () => transports;
  return {
    id: "ignored-by-the-encoder",
    rawId: bufferOf(251, 255, 190, 1),
    type: "public-key",
    authenticatorAttachment: "platform",
    response,
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  };
}

function containerReturning(value: unknown): {
  container: CredentialsContainerLike;
  calls: Array<{ publicKey: unknown }>;
} {
  const calls: Array<{ publicKey: unknown }> = [];
  return {
    calls,
    container: {
      create: (options) => {
        calls.push(options);
        return Promise.resolve(value);
      },
      get: (options) => {
        calls.push(options);
        return Promise.resolve(value);
      },
    },
  };
}

Deno.test("a created credential encodes unpadded with id equal to rawId and transports passed through", async () => {
  const { container, calls } = containerReturning(
    fakeCredential(["internal", "hybrid"]),
  );
  const json = await createPasskeyCredential({
    challenge: "AQID",
    user: { id: "BAUG", name: "alex@example.com" },
  }, container);
  assertEquals(calls.length, 1);
  assertEquals(json.rawId, "-_--AQ");
  assertEquals(json.id, json.rawId);
  assertEquals(json.type, "public-key");
  assertEquals(json.authenticatorAttachment, "platform");
  assertEquals(json.clientExtensionResults, { credProps: { rk: true } });
  const response = json.response as Record<string, unknown>;
  assertEquals(response.clientDataJSON, "AQI");
  assertEquals(response.attestationObject, "AwQF");
  assertEquals(response.transports, ["internal", "hybrid"]);
  assert(!JSON.stringify(json).includes("="), "no padded base64url anywhere");
});

Deno.test("a credential without getTransports reports no transports", async () => {
  const { container } = containerReturning(fakeCredential(null));
  const json = await createPasskeyCredential({
    challenge: "AQID",
    user: { id: "BAUG", name: "alex@example.com" },
  }, container);
  assertEquals((json.response as Record<string, unknown>).transports, []);
});

Deno.test("an assertion encodes signature and user handle", async () => {
  const { container } = containerReturning({
    id: "x",
    rawId: bufferOf(1, 2, 3),
    type: "public-key",
    response: {
      clientDataJSON: bufferOf(1),
      authenticatorData: bufferOf(2),
      signature: bufferOf(3),
      userHandle: bufferOf(4),
    },
  });
  const json = await getPasskeyAssertion({ challenge: "AQID" }, container);
  assertEquals(json.id, "AQID");
  assertEquals(json.rawId, "AQID");
  assertEquals(json.response, {
    clientDataJSON: "AQ",
    authenticatorData: "Ag",
    signature: "Aw",
    userHandle: "BA",
  });
});

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

Deno.test("dismissing the prompt is canceled, missing support is unsupported", async () => {
  assertEquals(
    classifyWebAuthnError(namedError("NotAllowedError")),
    "canceled",
  );
  assertEquals(classifyWebAuthnError(namedError("AbortError")), "canceled");
  assertEquals(
    classifyWebAuthnError(namedError("NotSupportedError")),
    "unsupported",
  );
  assertEquals(classifyWebAuthnError(namedError("SecurityError")), "failed");
  assertEquals(classifyWebAuthnError("boom"), "failed");

  const options = {
    challenge: "AQID",
    user: { id: "BAUG", name: "alex@example.com" },
  };
  const rejecting = (error: Error): CredentialsContainerLike => ({
    create: () => Promise.reject(error),
    get: () => Promise.reject(error),
  });
  const kindOf = async (container: CredentialsContainerLike | null) => {
    const error = await assertRejects(
      () => createPasskeyCredential(options, container),
      WebAuthnCeremonyError,
    );
    return error.kind;
  };
  assertEquals(
    await kindOf(rejecting(namedError("NotAllowedError"))),
    "canceled",
  );
  assertEquals(await kindOf(rejecting(namedError("AbortError"))), "canceled");
  assertEquals(
    await kindOf(rejecting(namedError("NotSupportedError"))),
    "unsupported",
  );
  assertEquals(
    await kindOf(rejecting(namedError("InvalidStateError"))),
    "failed",
  );
  // No `navigator.credentials` at all: the API itself is missing.
  assertEquals(await kindOf(null), "unsupported");
  // A null credential means the prompt closed without choosing one.
  assertEquals(await kindOf(containerReturning(null).container), "canceled");
  await assertRejects(
    () => getPasskeyAssertion({ challenge: "AQID" }, null),
    WebAuthnCeremonyError,
  );
});

Deno.test("aborting the signal cancels the pending create and get ceremonies", async () => {
  for (const kind of ["create", "get"] as const) {
    let seen: AbortSignal | undefined;
    const pending = (signal?: AbortSignal) =>
      new Promise<never>((_, reject) => {
        seen = signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const credentials: CredentialsContainerLike = {
      create: ({ signal }) => pending(signal),
      get: ({ signal }) => pending(signal),
    };
    const controller = new AbortController();
    const ceremony = kind === "create"
      ? createPasskeyCredential(
        {
          challenge: "AQID",
          rp: { name: "Bakery" },
          user: { id: "BAUG", name: "a@example.test", displayName: "A" },
        },
        credentials,
        controller.signal,
      )
      : getPasskeyAssertion(
        { challenge: "AQID" },
        credentials,
        controller.signal,
      );
    assert(seen === controller.signal, `${kind} receives the signal`);
    controller.abort();
    const failure = await assertRejects(() => ceremony, WebAuthnCeremonyError);
    assertEquals(failure.kind, "canceled");
  }
});
