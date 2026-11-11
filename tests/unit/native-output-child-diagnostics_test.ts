import { assertEquals } from "@std/assert";
import {
  classifyNativeOutputChildFailure,
  nativeOutputChildFailureMessage,
} from "../e2e/helpers/native-output-child-diagnostics.ts";

const encoder = new TextEncoder();

Deno.test("native output child diagnostic surfaces only known phase and failure class", () => {
  const output = {
    stdout: encoder.encode(
      "native-output-e2e: happy-path\n" +
        "credential=hosted-secret-value\n\u001b[31muntrusted stdout\u001b[0m",
    ),
    stderr: encoder.encode(
      "Error: NATIVE_OUTPUT_STREAM_CLOSE_TIMEOUT\n" +
        "stack contains bearer hosted-token-value",
    ),
  };

  assertEquals(classifyNativeOutputChildFailure(output), {
    phase: "happy-path",
    failureClass: "stream-close-timeout",
  });
  assertEquals(
    nativeOutputChildFailureMessage(1, output),
    "NATIVE_OUTPUT_CHILD_FAILED:1;phase=happy-path;class=stream-close-timeout",
  );
});

Deno.test("native output child diagnostic fails closed for untrusted output", () => {
  const secret = "credential=arbitrary-secret-value";
  const untrusted = `${"x".repeat(70_000)}\n\u001b[2J${secret}\n` +
    "Error: arbitrary hosted stack text";
  const output = {
    stdout: encoder.encode(untrusted),
    stderr: encoder.encode("Bearer arbitrary-token-value"),
  };
  const message = nativeOutputChildFailureMessage(73, output);

  assertEquals(
    message,
    "NATIVE_OUTPUT_CHILD_FAILED:73;phase=unknown;class=unknown",
  );
  assertEquals(message.includes(secret), false);
  assertEquals(message.includes("arbitrary-token-value"), false);
  assertEquals(message.includes("\u001b"), false);
  assertEquals(encoder.encode(message).byteLength < 128, true);
});

Deno.test("native output child diagnostic reports timeout without child text", () => {
  const output = {
    stdout: encoder.encode("native-output-e2e: inspection"),
    stderr: encoder.encode("credential=must-not-appear"),
  };

  assertEquals(
    nativeOutputChildFailureMessage(143, output, true),
    "NATIVE_OUTPUT_CHILD_FAILED:143;phase=inspection;class=child-timeout",
  );
});

Deno.test("native output child diagnostic relays only the child's enumerated state line", () => {
  const detail =
    '{"worker":"cancellation","code":"WORKER_REQUEST_TIMEOUT","attempts":[{"status":"leased"}]}';
  const output = {
    stdout: encoder.encode("native-output-e2e: cancellation\n"),
    stderr: encoder.encode(
      "credential=hosted-secret-value\n" +
        `NATIVE_OUTPUT_DETAIL:${detail}\n` +
        "Error: NATIVE_OUTPUT_WORKER_MAIN_FAILED:cancellation\n",
    ),
  };

  assertEquals(classifyNativeOutputChildFailure(output), {
    phase: "cancellation",
    failureClass: "worker-main-failed",
    detail,
  });
  const message = nativeOutputChildFailureMessage(1, output);
  assertEquals(
    message,
    `NATIVE_OUTPUT_CHILD_FAILED:1;phase=cancellation;class=worker-main-failed;detail=${detail}`,
  );
  assertEquals(message.includes("hosted-secret-value"), false);
});

Deno.test("native output child diagnostic drops detail lines outside the safe set", () => {
  for (
    const line of [
      "NATIVE_OUTPUT_DETAIL:\u001b[2Jcredential=x",
      "NATIVE_OUTPUT_DETAIL:Bearer abc/def@host",
      `NATIVE_OUTPUT_DETAIL:${"a".repeat(513)}`,
      "NATIVE_OUTPUT_DETAIL:",
    ]
  ) {
    const output = {
      stdout: encoder.encode("native-output-e2e: inspection\n"),
      stderr: encoder.encode(
        `${line}\nError: NATIVE_OUTPUT_INSPECTION_CLOSE_TIMEOUT`,
      ),
    };
    assertEquals(classifyNativeOutputChildFailure(output), {
      phase: "inspection",
      failureClass: "inspection-close-timeout",
    });
  }
});
