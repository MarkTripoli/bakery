export class BakeryException extends Error {}

export class ContractQualityError extends BakeryException {
  constructor(message: string) {
    super(message);
    this.name = "ContractQualityError";
  }
}
