import type { ApiFailure } from "../api/client.ts";
import type { IntentStore } from "./task-composer-intent.ts";

/** A refused admission is client-observed evidence, not an inferred run state. */
export type RunAdmissionRefusal = Readonly<{ code: string; title: string }>;

export function admissionRefusal(failure: ApiFailure): RunAdmissionRefusal {
  return failure.kind === "problem"
    ? { code: failure.problem.code, title: failure.problem.title }
    : { code: "", title: "" };
}

export function readAdmissionRefusal(
  store: IntentStore | undefined,
  key: string,
): RunAdmissionRefusal | null {
  try {
    const value: unknown = JSON.parse(
      store?.getItem(`${key}:refusal`) ?? "null",
    );
    return typeof value === "object" && value !== null &&
        "code" in value && typeof value.code === "string" &&
        "title" in value && typeof value.title === "string"
      ? { code: value.code, title: value.title }
      : null;
  } catch {
    return null;
  }
}

export function writeAdmissionRefusal(
  store: IntentStore | undefined,
  key: string,
  refusal: RunAdmissionRefusal | null,
): void {
  try {
    if (refusal) store?.setItem(`${key}:refusal`, JSON.stringify(refusal));
    else store?.removeItem(`${key}:refusal`);
  } catch {
    // Storage can be unavailable; the mounted detail still keeps its notice.
  }
}
