/** One activation or contract defect with a stable code and exact location. */
export type IntegrationDefect = {
  code: string;
  path: string;
  message: string;
};

/** Thrown when an integration definition fails activation parity checks. */
export class IntegrationActivationError extends Error {
  readonly defects: readonly IntegrationDefect[];
  constructor(defects: readonly IntegrationDefect[]) {
    super(
      `integration activation failed: ${
        defects.map((d) => `${d.path} [${d.code}] ${d.message}`).join("; ")
      }`,
    );
    this.name = "IntegrationActivationError";
    this.defects = defects;
  }
}

/** Thrown when handler input, output or recovery result violates its declared contract. */
export class IntegrationContractError extends Error {
  readonly kind: "input" | "output" | "output-size" | "reconcile-result";
  constructor(kind: IntegrationContractError["kind"], message: string) {
    super(message);
    this.name = "IntegrationContractError";
    this.kind = kind;
  }
}
