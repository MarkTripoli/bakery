import { StandardError } from "@bakery/contracts/http";
import {
  POSTGRES_FOREIGN_KEY_REFUSALS,
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "./postgres-errors.ts";

const BAD_VALUE_CODES: readonly string[] = ["22001", "22P02", "23502"];
const CHECK_VIOLATION = "23514";

export type BoundedMutationOptions = {
  readonly checkViolationIsUnprocessable?: boolean;
  readonly conflictParams?: (
    error: unknown,
  ) => Record<string, string> | undefined;
};

export async function boundedPostgresMutation<T>(
  work: () => Promise<T>,
  options: BoundedMutationOptions = {},
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StandardError) throw error;
    const code = postgresErrorCode(error) ?? "";
    if (code === POSTGRES_UNIQUE_VIOLATION) {
      const params = options.conflictParams?.(error);
      throw new StandardError({
        code: "STATE_CONFLICT",
        cause: error,
        ...(params ? { params } : {}),
      });
    }
    const unprocessable = [
      ...BAD_VALUE_CODES,
      ...(options.checkViolationIsUnprocessable ? [CHECK_VIOLATION] : []),
      ...POSTGRES_FOREIGN_KEY_REFUSALS,
    ];
    if (unprocessable.includes(code)) {
      throw new StandardError({ code: "UNPROCESSABLE", cause: error });
    }
    throw error;
  }
}
