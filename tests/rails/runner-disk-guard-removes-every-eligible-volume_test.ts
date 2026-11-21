import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { removeTreeSync } from "../../scripts/ci/temp-tree.ts";

// A runner host's disk filled because its disk guard left eligible Docker volumes
// behind (#559): it removed dangling volumes before it pruned stopped containers,
// and a volume is only dangling once the last container holding it is gone, so
// the volumes of a killed run survived the pass that removed their containers.
// These run the real guard functions against a stub `docker` that keeps
// containers and volumes as files, so every case states exactly what is kept.

const repository = new URL("../../", import.meta.url).pathname;
const GUARD = join(repository, "scripts/runner-host/runner-disk-guard.sh");
const decoder = new TextDecoder();

const STUB_DOCKER = `#!/usr/bin/env bash
S="$STUB_STATE"
echo "$DOCKER_HOST $*" >> "$S/docker.calls"
case "$1 $2" in
  "info "*) exit 0 ;;
  "volume ls")
    for v in "$S"/volumes/*; do
      [ -e "$v" ] || continue
      n="$(basename "$v")"
      case "$n" in *.refuse) continue ;; esac
      held=0
      for c in "$S"/containers/*; do
        [ -e "$c" ] || continue
        grep -qx "volume=$n" "$c" && held=1
      done
      [ "$held" = 0 ] && echo "$n"
    done ;;
  "volume inspect") cat "$S/volumes/$5" ;;
  "volume rm")
    if [ -e "$S/volumes/$3.refuse" ]; then
      echo "Error response from daemon: remove $3: volume is in use" >&2
      exit 1
    fi
    rm -f "$S/volumes/$3" ;;
  "container prune")
    hours="\${5#until=}"; hours="\${hours%h}"
    cutoff=$(( $(date +%s) - hours * 3600 ))
    for c in "$S"/containers/*; do
      [ -e "$c" ] || continue
      state="$(sed -n 's/^state=//p' "$c")"
      created="$(sed -n 's/^created=//p' "$c")"
      if [ "$state" = stopped ] && [ "$created" -lt "$cutoff" ]; then rm -f "$c"; fi
    done ;;
  "image prune" | "builder prune") echo "$1 $2" >> "$S/calls.log" ;;
esac
`;

const hoursAgoIso = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString().replace(
    /\.\d+Z$/,
    "Z",
  );
const hoursAgoEpoch = (hours: number) =>
  Math.floor(Date.now() / 1000 - hours * 3600);

type Container = {
  name: string;
  state: "running" | "stopped";
  ageHours: number;
  volume?: string;
};
type Volume = { name: string; ageHours: number; refuseRemoval?: boolean };

/** Builds the stub host, runs one shell snippet that has sourced the guard, and reads back what is left. */
async function onStubHost(
  host: { containers?: Container[]; volumes: Volume[] },
  snippet: string,
  extra: {
    env?: Record<string, string>;
    bins?: Record<string, string>;
    prepare?: (root: string) => Promise<void>;
  } = {},
) {
  const root = Deno.makeTempDirSync({ prefix: "bakery-disk-guard-" });
  try {
    Deno.mkdirSync(join(root, "bin"));
    Deno.mkdirSync(join(root, "state/containers"), { recursive: true });
    Deno.mkdirSync(join(root, "state/volumes"));
    Deno.writeTextFileSync(join(root, "bin/docker"), STUB_DOCKER, {
      mode: 0o755,
    });
    for (const [name, script] of Object.entries(extra.bins ?? {})) {
      Deno.writeTextFileSync(join(root, "bin", name), script, { mode: 0o755 });
    }
    await extra.prepare?.(root);
    for (const volume of host.volumes) {
      Deno.writeTextFileSync(
        join(root, "state/volumes", volume.name),
        hoursAgoIso(volume.ageHours),
      );
      if (volume.refuseRemoval) {
        Deno.writeTextFileSync(
          join(root, "state/volumes", `${volume.name}.refuse`),
          "",
        );
      }
    }
    for (const container of host.containers ?? []) {
      Deno.writeTextFileSync(
        join(root, "state/containers", container.name),
        `state=${container.state}\ncreated=${
          hoursAgoEpoch(container.ageHours)
        }\n${container.volume ? `volume=${container.volume}\n` : ""}`,
      );
    }
    const logFile = join(root, "guard.log");
    const result = await new Deno.Command("bash", {
      args: ["-c", `source "$GUARD"; ${snippet}`],
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        STUB_STATE: join(root, "state"),
        GUARD: GUARD,
        GUARD_LOG_FILE: logFile,
        LIMIT_PCT: "75",
        MIN_AGE_HOURS: "2",
        IDLE_AGE_HOURS: "24",
        GUARD_RUN_DIR: join(root, "run"),
        ...extra.env,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(decoder.decode(result.stderr));
    }
    const list = (directory: string) =>
      [...Deno.readDirSync(join(root, "state", directory))]
        .map((entry) => entry.name)
        .filter((name) => !name.endsWith(".refuse"))
        .sort();
    const read = (file: string) => {
      try {
        return Deno.readTextFileSync(join(root, file));
      } catch {
        return "";
      }
    };
    return {
      volumes: list("volumes"),
      containers: list("containers"),
      log: read("guard.log"),
      calls: read("state/calls.log"),
      dockerCalls: read("state/docker.calls"),
      stdout: decoder.decode(result.stdout),
    };
  } finally {
    removeTreeSync(root);
  }
}

Deno.test("a volume held by an old stopped container is removed in the same pass", async () => {
  const left = await onStubHost(
    {
      containers: [{
        name: "c1",
        state: "stopped",
        ageHours: 30,
        volume: "held-by-stopped",
      }],
      volumes: [{ name: "held-by-stopped", ageHours: 30 }],
    },
    "prune_docker 2 1",
  );
  assertEquals(left.containers, []);
  assertEquals(left.volumes, []);
  assertStringIncludes(left.log, "removed volume held-by-stopped");
});

Deno.test("only a dangling volume older than the age goes", async () => {
  const left = await onStubHost(
    {
      volumes: [
        { name: "fresh", ageHours: 1 },
        { name: "stale", ageHours: 3 },
      ],
    },
    "prune_docker 2 1",
  );
  assertEquals(left.volumes, ["fresh"]);
});

Deno.test("a volume a running container holds is never removed, however old", async () => {
  const left = await onStubHost(
    {
      containers: [{
        name: "live",
        state: "running",
        ageHours: 200,
        volume: "in-use",
      }],
      volumes: [{ name: "in-use", ageHours: 200 }],
    },
    "prune_docker 2 1",
  );
  assertEquals(left.containers, ["live"]);
  assertEquals(left.volumes, ["in-use"]);
});

Deno.test("a refused removal is logged, not swallowed, and the next volume is still tried", async () => {
  const left = await onStubHost(
    {
      volumes: [
        { name: "a-stuck", ageHours: 50, refuseRemoval: true },
        { name: "b-free", ageHours: 50 },
      ],
    },
    "prune_docker 2 1",
  );
  assertEquals(left.volumes, ["a-stuck"]);
  assertStringIncludes(left.log, "could not remove volume a-stuck");
  assertStringIncludes(left.log, "volume is in use");
  assertStringIncludes(left.log, "removed volume b-free");
});

Deno.test("below the limit the sweep uses the long age and leaves images alone", async () => {
  const idleAge = await onStubHost({ volumes: [] }, "age_hours_for 40");
  assertEquals(idleAge.stdout.trim(), "24");
  const pressureAge = await onStubHost({ volumes: [] }, "age_hours_for 80");
  assertEquals(pressureAge.stdout.trim(), "2");

  const idle = await onStubHost(
    {
      volumes: [{ name: "three-hours", ageHours: 3 }, {
        name: "two-days",
        ageHours: 48,
      }],
    },
    "prune_docker 24 0",
  );
  assertEquals(idle.volumes, ["three-hours"]);
  assertEquals(idle.calls, "");

  const pressure = await onStubHost(
    { volumes: [{ name: "three-hours", ageHours: 3 }] },
    "prune_docker 2 1",
  );
  assertEquals(pressure.volumes, []);
  assertStringIncludes(pressure.calls, "image prune");
  assertStringIncludes(pressure.calls, "builder prune");
});

// Other projects' runners share these hosts under the `runner` user, and their Docker
// is not the guard's to prune. The guard's own `main` runs here against a host
// where both users have a Docker socket.
const THIS_RUNNER_UID = "1001";
const OTHER_RUNNER_UID = "1002";

async function bothUsersHaveADocker(root: string) {
  for (const uid of [THIS_RUNNER_UID, OTHER_RUNNER_UID]) {
    Deno.mkdirSync(join(root, "run", uid), { recursive: true });
    const made = await new Deno.Command("python3", {
      args: [
        "-c",
        "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])",
        join(root, "run", uid, "docker.sock"),
      ],
    }).output();
    if (!made.success) throw new Error(decoder.decode(made.stderr));
  }
}

const HOST_USERS = {
  id: `#!/usr/bin/env bash
case "$2" in ci-runner) echo \${STUB_THIS_UID} ;; runner) echo \${STUB_OTHER_UID} ;; *) exit 1 ;; esac
`,
  df: `#!/usr/bin/env bash
printf 'Use%%\n 40%%\n'
`,
};

Deno.test("the guard prunes only this project's runner user, never another project's Docker", async () => {
  const onBothUsersHost = (guardUsers?: string) =>
    onStubHost(
      { volumes: [{ name: "leaked", ageHours: 48 }] },
      "main",
      {
        bins: HOST_USERS,
        env: {
          STUB_THIS_UID: THIS_RUNNER_UID,
          STUB_OTHER_UID: OTHER_RUNNER_UID,
          ...(guardUsers === undefined ? {} : { GUARD_USERS: guardUsers }),
        },
        prepare: bothUsersHaveADocker,
      },
    );

  const byDefault = await onBothUsersHost();
  assertStringIncludes(
    byDefault.dockerCalls,
    `/run/${THIS_RUNNER_UID}/docker.sock`,
  );
  assertEquals(byDefault.dockerCalls.includes(`/${OTHER_RUNNER_UID}/`), false);
  assertEquals(byDefault.volumes, []);

  // The control: asked to include the other user, the same stub host does reach
  // that Docker, so the assertion above is not passing for want of a socket.
  const both = await onBothUsersHost("ci-runner runner");
  assertStringIncludes(both.dockerCalls, `/${OTHER_RUNNER_UID}/docker.sock`);
});

Deno.test("no runner hook cleans with a zero age, so it never deletes a running job's files", () => {
  for (const hook of ["runner-job-started.sh", "runner-job-completed.sh"]) {
    const text = Deno.readTextFileSync(
      join(repository, "scripts/runner-host", hook),
    );
    const ages = [...text.matchAll(/runner-job-cleanup\.sh\s+(\d+)/g)].map((
      m,
    ) => Number(m[1]));
    assertEquals(ages.length > 0, true, `${hook} calls the cleanup`);
    for (const age of ages) {
      assertEquals(age >= 10, true, `${hook} cleans at age ${age}`);
    }
  }
});

Deno.test("the git guard only ever touches the ci-runner checkout", async () => {
  const text = Deno.readTextFileSync(
    join(repository, "scripts/runner-host/runner-git-guard.sh"),
  );
  assertEquals(
    text.includes("/home/"),
    false,
    "no glob over other users' home directories",
  );
  assertEquals(
    text.includes("actions-runner*"),
    false,
    "no glob over other runner directories",
  );

  const root = Deno.makeTempDirSync({ prefix: "bakery-git-guard-" });
  try {
    Deno.mkdirSync(join(root, "bin"));
    Deno.writeTextFileSync(
      join(root, "bin/logger"),
      "#!/usr/bin/env bash\nexit 0\n",
      { mode: 0o755 },
    );
    const checkout = join(root, "_work/bakery/bakery");
    Deno.mkdirSync(join(checkout, ".git"), { recursive: true });
    const out = await new Deno.Command("bash", {
      args: [join(repository, "scripts/runner-host/runner-git-guard.sh")],
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        GUARD_CHECKOUTS: checkout,
        DRY_RUN: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    // The checkout belongs to whoever runs this test, not to ci-runner.
    assertStringIncludes(decoder.decode(out.stdout), "not ci-runner: skipped");
  } finally {
    removeTreeSync(root);
  }
});
