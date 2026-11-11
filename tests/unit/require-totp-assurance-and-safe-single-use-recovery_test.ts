import { assertEquals } from "@std/assert";
import {
  resolveSessionAssurance,
  SessionAssurance,
} from "../../apps/server/src/modules/auth/domain/assurance.ts";

Deno.test("resolveSessionAssurance truth table", () => {
  const cases: readonly {
    name: string;
    twoFactorEnabled: boolean;
    factorVerifiedAt: Date | null;
    expected: SessionAssurance;
  }[] = [
    {
      name: "no second factor enrolled, no evidence",
      twoFactorEnabled: false,
      factorVerifiedAt: null,
      expected: SessionAssurance.Verified,
    },
    {
      name: "no second factor enrolled, stale evidence present",
      twoFactorEnabled: false,
      factorVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      expected: SessionAssurance.Verified,
    },
    {
      name: "second factor enrolled, no evidence",
      twoFactorEnabled: true,
      factorVerifiedAt: null,
      expected: SessionAssurance.Pending,
    },
    {
      name: "second factor enrolled, evidence recorded",
      twoFactorEnabled: true,
      factorVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      expected: SessionAssurance.Verified,
    },
  ];
  for (const testCase of cases) {
    assertEquals(
      resolveSessionAssurance({
        twoFactorEnabled: testCase.twoFactorEnabled,
        factorVerifiedAt: testCase.factorVerifiedAt,
      }),
      testCase.expected,
      testCase.name,
    );
  }
});
