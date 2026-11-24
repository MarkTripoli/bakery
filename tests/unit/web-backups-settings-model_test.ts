import { assertEquals } from "@std/assert";
import {
  classifySaveFailure,
  keysRequired,
  localTimeOfDay,
  offsiteDraftOf,
  offsiteInput,
  offsiteProblems,
  offsiteReady,
  offsiteRequiredProblems,
  pointInTimeView,
  scheduleChanged,
  scheduleDraftOf,
  scheduleInput,
  scheduleProblems,
  scheduleTimeOfDay,
} from "../../apps/web/src/screens/backups/backups-settings-model.ts";

const SAVED_SCHEDULE = {
  enabled: true,
  interval: "daily" as const,
  timeOfDayUtc: "03:00",
  daysToKeep: 30,
};

const SAVED_OFFSITE = {
  configured: true,
  endpoint: "https://s3.example.com",
  region: "eu-west-1",
  bucket: "bakery-backups",
};

const DRAFT = {
  endpoint: "https://s3.example.com",
  region: "eu-west-1",
  bucket: "bakery-backups",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: "",
};

Deno.test("a schedule draft starts from what is saved", () => {
  const draft = scheduleDraftOf(SAVED_SCHEDULE);
  assertEquals(draft, {
    enabled: true,
    interval: "daily",
    time: "03:00",
    minute: "00",
    daysToKeep: "30",
  });
  assertEquals(scheduleChanged(draft, SAVED_SCHEDULE), false);
  assertEquals(
    scheduleChanged({ ...draft, enabled: false }, SAVED_SCHEDULE),
    true,
  );
  assertEquals(
    scheduleChanged({ ...draft, daysToKeep: "31" }, SAVED_SCHEDULE),
    true,
  );
});

Deno.test("the schedule time is checked in words", () => {
  const draft = scheduleDraftOf(SAVED_SCHEDULE);
  assertEquals(scheduleProblems(draft), {});
  assertEquals(
    scheduleProblems({ ...draft, time: "25:00" }).time,
    "installation.backups.settings.schedule.time.invalid",
  );
  assertEquals(
    scheduleProblems({ ...draft, time: "3:00" }).time,
    "installation.backups.settings.schedule.time.invalid",
  );
  assertEquals(
    scheduleProblems({ ...draft, time: "12:60" }).time,
    "installation.backups.settings.schedule.time.invalid",
  );
  assertEquals(scheduleProblems({ ...draft, time: "23:59" }), {});
  assertEquals(scheduleProblems({ ...draft, time: "00:00" }), {});
});

Deno.test("hourly checks the minutes, not the time of day", () => {
  const hourly = {
    ...scheduleDraftOf(SAVED_SCHEDULE),
    interval: "hourly" as const,
    time: "garbage",
  };
  assertEquals(scheduleProblems({ ...hourly, minute: "15" }), {});
  assertEquals(
    scheduleProblems({ ...hourly, minute: "60" }).minute,
    "installation.backups.settings.schedule.minute.invalid",
  );
  assertEquals(
    scheduleProblems({ ...hourly, minute: "" }).minute,
    "installation.backups.settings.schedule.minute.invalid",
  );
  assertEquals(scheduleTimeOfDay({ ...hourly, minute: "7" }), "00:07");
  assertEquals(scheduleTimeOfDay({ ...hourly, minute: "15" }), "00:15");
});

Deno.test("days to keep run from 1 to 3650", () => {
  const draft = scheduleDraftOf(SAVED_SCHEDULE);
  for (const days of ["1", "3650", "30"]) {
    assertEquals(scheduleProblems({ ...draft, daysToKeep: days }), {});
  }
  for (const days of ["0", "3651", "", "1.5", "-1", "abc"]) {
    assertEquals(
      scheduleProblems({ ...draft, daysToKeep: days }).daysToKeep,
      "installation.backups.settings.schedule.days.invalid",
    );
  }
});

Deno.test("the schedule input is exact or absent", () => {
  const draft = scheduleDraftOf(SAVED_SCHEDULE);
  assertEquals(scheduleInput({ ...draft, interval: "weekly", time: "04:30" }), {
    enabled: true,
    interval: "weekly",
    timeOfDayUtc: "04:30",
    daysToKeep: 30,
  });
  assertEquals(scheduleInput({ ...draft, time: "99:99" }), null);
  assertEquals(
    scheduleInput({
      ...draft,
      enabled: false,
      interval: "hourly",
      minute: "5",
    }),
    {
      enabled: false,
      interval: "hourly",
      timeOfDayUtc: "00:05",
      daysToKeep: 30,
    },
  );
  assertEquals(
    scheduleInput({ ...draft, interval: "hourly", minute: "5" })!.timeOfDayUtc
      .length,
    5,
  );
});

Deno.test("the local time is shown only when the zone differs", () => {
  const now = Date.parse("2026-11-23T12:00:00.000Z");
  assertEquals(localTimeOfDay("03:00", now, "en-US", "UTC"), null);
  assertEquals(
    localTimeOfDay("03:00", now, "en-US", "America/New_York"),
    "22:00",
  );
  assertEquals(localTimeOfDay("03:30", now, "en-US", "Asia/Kolkata"), "09:00");
  assertEquals(localTimeOfDay("25:00", now, "en-US", "Asia/Kolkata"), null);
  assertEquals(localTimeOfDay("", now, "en-US", "Asia/Kolkata"), null);
});

Deno.test("the local time follows daylight saving on the day shown", () => {
  const winter = Date.parse("2026-01-15T12:00:00.000Z");
  const summer = Date.parse("2026-07-15T12:00:00.000Z");
  assertEquals(
    localTimeOfDay("12:00", winter, "en-US", "America/New_York"),
    "07:00",
  );
  assertEquals(
    localTimeOfDay("12:00", summer, "en-US", "America/New_York"),
    "08:00",
  );
});

Deno.test("the service address must be an https origin", () => {
  const check = (endpoint: string) =>
    offsiteProblems({ ...DRAFT, endpoint }, SAVED_OFFSITE).endpoint;
  assertEquals(check("https://s3.example.com"), undefined);
  assertEquals(check("https://s3.example.com:9000"), undefined);
  assertEquals(
    check("http://s3.example.com"),
    "installation.backups.settings.offsite.endpoint.scheme",
  );
  assertEquals(
    check("s3.example.com"),
    "installation.backups.settings.offsite.endpoint.scheme",
  );
  assertEquals(
    check("https://s3.example.com/bucket"),
    "installation.backups.settings.offsite.endpoint.origin",
  );
  assertEquals(
    check("https://s3.example.com/"),
    "installation.backups.settings.offsite.endpoint.origin",
  );
  assertEquals(
    check("https://user@s3.example.com"),
    "installation.backups.settings.offsite.endpoint.origin",
  );
  assertEquals(
    check("https://s3.example.com?x=1"),
    "installation.backups.settings.offsite.endpoint.origin",
  );
  assertEquals(check("HTTPS://s3.example.com"), undefined);
});

Deno.test("the bucket name follows the contract", () => {
  const check = (bucket: string) =>
    offsiteProblems({
      ...DRAFT,
      bucket,
      accessKeyId: "a",
      secretAccessKey: "b",
    }, SAVED_OFFSITE)
      .bucket;
  assertEquals(check("bakery-backups"), undefined);
  assertEquals(check("a.b-c"), undefined);
  assertEquals(
    check("ab"),
    "installation.backups.settings.offsite.bucket.invalid",
  );
  assertEquals(
    check("Bakery"),
    "installation.backups.settings.offsite.bucket.invalid",
  );
  assertEquals(
    check("-bakery"),
    "installation.backups.settings.offsite.bucket.invalid",
  );
  assertEquals(
    check("bakery-"),
    "installation.backups.settings.offsite.bucket.invalid",
  );
  assertEquals(
    check("a".repeat(64)),
    "installation.backups.settings.offsite.bucket.invalid",
  );
  assertEquals(check("a".repeat(63)), undefined);
});

Deno.test("region and folder have their limits", () => {
  assertEquals(
    offsiteProblems({
      ...DRAFT,
      region: "r".repeat(64),
      accessKeyId: "a",
      secretAccessKey: "b",
    }, SAVED_OFFSITE).region,
    "installation.backups.settings.offsite.region.invalid",
  );
  assertEquals(
    offsiteProblems({ ...DRAFT, prefix: "p".repeat(257) }, SAVED_OFFSITE)
      .prefix,
    "installation.backups.settings.offsite.prefix.invalid",
  );
  assertEquals(
    offsiteProblems({ ...DRAFT, prefix: "p".repeat(256) }, SAVED_OFFSITE)
      .prefix,
    undefined,
  );
});

Deno.test("the keys are entered together", () => {
  const both = "installation.backups.settings.offsite.keys.both";
  assertEquals(
    offsiteProblems({ ...DRAFT, accessKeyId: "a" }, SAVED_OFFSITE).keys,
    both,
  );
  assertEquals(
    offsiteProblems({ ...DRAFT, secretAccessKey: "b" }, SAVED_OFFSITE).keys,
    both,
  );
  assertEquals(
    offsiteProblems(
      { ...DRAFT, accessKeyId: "a", secretAccessKey: "b" },
      SAVED_OFFSITE,
    ).keys,
    undefined,
  );
  assertEquals(offsiteProblems(DRAFT, SAVED_OFFSITE).keys, undefined);
  assertEquals(
    offsiteProblems({
      ...DRAFT,
      accessKeyId: "a".repeat(257),
      secretAccessKey: "b",
    }, SAVED_OFFSITE).keys,
    "installation.backups.settings.offsite.keys.tooLong",
  );
  assertEquals(
    offsiteProblems({
      ...DRAFT,
      accessKeyId: "a",
      secretAccessKey: "b".repeat(1025),
    }, SAVED_OFFSITE).keys,
    "installation.backups.settings.offsite.keys.tooLong",
  );
});

Deno.test("keys are needed for a first save and for any move", () => {
  assertEquals(keysRequired(DRAFT, SAVED_OFFSITE), false);
  assertEquals(keysRequired({ ...DRAFT, prefix: "x" }, SAVED_OFFSITE), false);
  assertEquals(
    keysRequired({ ...DRAFT, bucket: "other-bucket" }, SAVED_OFFSITE),
    true,
  );
  assertEquals(
    keysRequired({ ...DRAFT, region: "us-east-1" }, SAVED_OFFSITE),
    true,
  );
  assertEquals(
    keysRequired(
      { ...DRAFT, endpoint: "https://s3.example.org" },
      SAVED_OFFSITE,
    ),
    true,
  );
  assertEquals(
    keysRequired(DRAFT, {
      configured: false,
      endpoint: null,
      region: null,
      bucket: null,
    }),
    true,
  );
  assertEquals(
    offsiteProblems({ ...DRAFT, bucket: "other-bucket" }, SAVED_OFFSITE).keys,
    "installation.backups.settings.offsite.keys.both",
  );
});

Deno.test("the off-site form is ready only when it can be saved", () => {
  assertEquals(offsiteReady(DRAFT, SAVED_OFFSITE), true);
  assertEquals(
    offsiteReady({ ...DRAFT, bucket: "other-bucket" }, SAVED_OFFSITE),
    false,
  );
  assertEquals(
    offsiteReady({
      ...DRAFT,
      bucket: "other-bucket",
      accessKeyId: "a",
      secretAccessKey: "b",
    }, SAVED_OFFSITE),
    true,
  );
  assertEquals(offsiteReady({ ...DRAFT, endpoint: "" }, SAVED_OFFSITE), false);
  assertEquals(offsiteReady({ ...DRAFT, region: " " }, SAVED_OFFSITE), false);
  assertEquals(
    offsiteReady({ ...DRAFT, endpoint: "http://x.example" }, SAVED_OFFSITE),
    false,
  );
});

Deno.test("the off-site input leaves the keys out unless both are typed", () => {
  assertEquals(
    offsiteInput({ ...DRAFT, endpoint: " https://s3.example.com " }),
    {
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      bucket: "bakery-backups",
      prefix: "",
    },
  );
  assertEquals(
    offsiteInput({
      ...DRAFT,
      prefix: " bakery/prod ",
      accessKeyId: "a",
      secretAccessKey: "b",
    }),
    {
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      bucket: "bakery-backups",
      prefix: "bakery/prod",
      accessKeyId: "a",
      secretAccessKey: "b",
    },
  );
});

Deno.test("a refused save is told apart by status, code and issue", () => {
  assertEquals(classifySaveFailure({ status: 412 }), "stale");
  assertEquals(classifySaveFailure({ status: 428 }), "stale");
  assertEquals(
    classifySaveFailure({ status: 422, issueCodes: ["credentials_required"] }),
    "credentialsRequired",
  );
  assertEquals(
    classifySaveFailure({ status: 422, issueCodes: ["other"] }),
    "invalid",
  );
  assertEquals(classifySaveFailure({ status: 422 }), "invalid");
  assertEquals(classifySaveFailure({ status: 400 }), "invalid");
  assertEquals(
    classifySaveFailure({ status: 409, code: "STATE_CONFLICT" }),
    "unavailable",
  );
  assertEquals(
    classifySaveFailure({
      status: 409,
      code: "STATE_CONFLICT",
      reason: "backend_active",
    }),
    "failed",
  );
  assertEquals(classifySaveFailure({ status: 500 }), "failed");
  assertEquals(classifySaveFailure({ status: null }), "failed");
});

Deno.test("the running record is off, waiting or a window", () => {
  const base = {
    enabled: true,
    earliestRestorableAt: "2026-11-20T00:00:00.000Z",
    latestRestorableAt: "2026-11-23T11:00:00.000Z",
    reportedAt: "2026-11-23T11:05:00.000Z",
  };
  assertEquals(pointInTimeView({ ...base, enabled: false }), { kind: "off" });
  assertEquals(
    pointInTimeView({
      ...base,
      enabled: false,
      earliestRestorableAt: null,
      latestRestorableAt: null,
      reportedAt: null,
    }),
    { kind: "off" },
  );
  assertEquals(
    pointInTimeView({
      ...base,
      earliestRestorableAt: null,
      latestRestorableAt: null,
      reportedAt: null,
    }),
    { kind: "waiting" },
  );
  assertEquals(pointInTimeView({ ...base, reportedAt: null }), {
    kind: "waiting",
  });
  assertEquals(pointInTimeView(base), {
    kind: "window",
    earliest: "2026-11-20T00:00:00.000Z",
    latest: "2026-11-23T11:00:00.000Z",
    reportedAt: "2026-11-23T11:05:00.000Z",
  });
});

Deno.test("empty required off-site fields each name their own problem when pressed", () => {
  const draft = offsiteDraftOf({
    endpoint: null,
    region: null,
    bucket: null,
    prefix: null,
  });
  assertEquals(offsiteRequiredProblems(draft), {
    endpoint: "installation.backups.settings.offsite.endpoint.scheme",
    region: "installation.backups.settings.offsite.region.required",
    bucket: "installation.backups.settings.offsite.bucket.invalid",
  });
  assertEquals(
    offsiteRequiredProblems({
      ...draft,
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "bakery-backups",
    }),
    {},
  );
});

Deno.test("an hourly minute must be a whole number from 0 to 59", () => {
  const hourly = {
    ...scheduleDraftOf(SAVED_SCHEDULE),
    interval: "hourly" as const,
  };
  assertEquals(scheduleProblems({ ...hourly, minute: "75" }), {
    minute: "installation.backups.settings.schedule.minute.invalid",
  });
  assertEquals(scheduleProblems({ ...hourly, minute: "7.5" }), {
    minute: "installation.backups.settings.schedule.minute.invalid",
  });
  assertEquals(scheduleProblems({ ...hourly, minute: "59" }), {});
  assertEquals(scheduleProblems({ ...hourly, minute: "0" }), {});
});
