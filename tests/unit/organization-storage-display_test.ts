import { assertEquals } from "@std/assert";
import type { StorageSettings } from "../../apps/web/src/api/client.ts";
import {
  belowStored,
  defaultDraft,
  draftChanged,
  draftOf,
  fieldProblem,
  firstProblem,
  GIGABYTE,
  putOf,
  sizeWords,
} from "../../apps/web/src/screens/storage/storage-display.ts";

const SAVED: StorageSettings = {
  workingVersionsKept: 20,
  trashRetentionDays: 30,
  scratchRetentionDays: 30,
  maxFileBytes: 5 * GIGABYTE,
  organizationQuotaBytes: 100 * GIGABYTE,
  projectQuotaBytes: 50 * GIGABYTE,
  personalQuotaBytes: 10 * GIGABYTE,
  stepWriteBytes: 2 * GIGABYTE,
  stepWriteFiles: 2000,
  organizationUsedBytes: 78 * GIGABYTE,
  organizationQuotaState: "warning",
  customized: true,
  version: 3,
};

Deno.test("the draft shows saved limits in whole gigabytes and plain counts", () => {
  assertEquals(draftOf(SAVED), {
    organizationQuotaBytes: "100",
    projectQuotaBytes: "50",
    personalQuotaBytes: "10",
    maxFileBytes: "5",
    stepWriteBytes: "2048",
    stepWriteFiles: "2000",
    workingVersionsKept: "20",
    trashRetentionDays: "30",
    scratchRetentionDays: "30",
  });
  assertEquals(draftChanged(draftOf(SAVED), SAVED), false);
});

Deno.test("Bakery's defaults are the design's numbers", () => {
  assertEquals(defaultDraft(), {
    organizationQuotaBytes: "100",
    projectQuotaBytes: "50",
    personalQuotaBytes: "10",
    maxFileBytes: "5",
    stepWriteBytes: "2048",
    stepWriteFiles: "2000",
    workingVersionsKept: "20",
    trashRetentionDays: "30",
    scratchRetentionDays: "30",
  });
});

Deno.test("a field is wrong when it is not a whole number in range", () => {
  assertEquals(fieldProblem("trashRetentionDays", "abc", SAVED), "whole");
  assertEquals(fieldProblem("trashRetentionDays", "0", SAVED), "whole");
  assertEquals(fieldProblem("trashRetentionDays", "1.5", SAVED), "whole");
  assertEquals(fieldProblem("trashRetentionDays", "3651", SAVED), "tooLarge");
  assertEquals(fieldProblem("trashRetentionDays", "3650", SAVED), null);
  assertEquals(fieldProblem("maxFileBytes", "6", SAVED), "tooLarge");
  assertEquals(firstProblem({ ...draftOf(SAVED), maxFileBytes: "9" }, SAVED), {
    field: "maxFileBytes",
    problem: "tooLarge",
  });
});

Deno.test("a save carries every limit in bytes, and an untouched one as it was saved", () => {
  const odd = { ...SAVED, projectQuotaBytes: 12.5 * GIGABYTE };
  const put = putOf({ ...draftOf(odd), organizationQuotaBytes: "200" }, odd);
  assertEquals(put.organizationQuotaBytes, 200 * GIGABYTE);
  // An API client set a project limit that is not whole gigabytes: left alone.
  assertEquals(put.projectQuotaBytes, 12.5 * GIGABYTE);
  assertEquals(put.workingVersionsKept, 20);
  // The step write limits are not on the page: a save sends them as stored.
  assertEquals(put.stepWriteBytes, 2 * GIGABYTE);
  assertEquals(put.stepWriteFiles, 2000);
  assertEquals(fieldProblem("projectQuotaBytes", "12.5", odd), null);
});

Deno.test("the agent step limits take megabytes and a file count, and an empty box is the default", () => {
  assertEquals(fieldProblem("stepWriteBytes", "0", SAVED), "whole");
  assertEquals(fieldProblem("stepWriteBytes", "1048577", SAVED), "tooLarge");
  assertEquals(fieldProblem("stepWriteBytes", "512", SAVED), null);
  assertEquals(fieldProblem("stepWriteFiles", "1000001", SAVED), "tooLarge");
  assertEquals(fieldProblem("stepWriteFiles", "x", SAVED), "whole");
  // Empty is allowed for these two and saves Bakery's default.
  assertEquals(fieldProblem("stepWriteFiles", "", SAVED), null);
  assertEquals(fieldProblem("stepWriteBytes", "", SAVED), null);
  assertEquals(fieldProblem("stepWriteBytes", "  ", SAVED), null);
  assertEquals(fieldProblem("maxFileBytes", "", SAVED), "whole");
  const put = putOf(
    { ...draftOf(SAVED), stepWriteBytes: "512", stepWriteFiles: "" },
    SAVED,
  );
  assertEquals(put.stepWriteBytes, 512 * 1024 * 1024);
  assertEquals(put.stepWriteFiles, 2000);
  // The megabytes box emptied saves 2 GB, and both emptied save both defaults.
  const emptied = putOf(
    { ...draftOf(SAVED), stepWriteBytes: "", stepWriteFiles: "" },
    SAVED,
  );
  assertEquals(emptied.stepWriteBytes, 2 * GIGABYTE);
  assertEquals(emptied.stepWriteFiles, 2000);
});

Deno.test("a quota below what is stored is flagged, not refused", () => {
  assertEquals(
    belowStored({ ...draftOf(SAVED), organizationQuotaBytes: "50" }, SAVED),
    true,
  );
  assertEquals(belowStored(draftOf(SAVED), SAVED), false);
  // A field that cannot be saved is a different warning, not this one.
  assertEquals(
    belowStored({ ...draftOf(SAVED), organizationQuotaBytes: "x" }, SAVED),
    false,
  );
});

Deno.test("sizes read in the largest unit that keeps one digit before the point", () => {
  assertEquals(sizeWords(13, "en"), { key: "files.size.bytes", value: "13" });
  assertEquals(sizeWords(1536, "en"), {
    key: "files.size.kilobytes",
    value: "1.5",
  });
  assertEquals(sizeWords(78.2 * GIGABYTE, "en"), {
    key: "files.size.gigabytes",
    value: "78.2",
  });
  assertEquals(sizeWords(2048 * GIGABYTE, "en"), {
    key: "organizationStorage.size.terabytes",
    value: "2",
  });
});
