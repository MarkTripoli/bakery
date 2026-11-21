/**
 * #80 P2: scripts/deploy/pitr-prepare.sh against a real Postgres 16. A
 * cluster archives WAL, takes a base backup the way backup.sh does
 * (pg_basebackup -F tar -X none), then commits one row before and one after a
 * chosen minute. A fresh data directory prepared from the base backup and the
 * archive must replay to that minute: the first row is there, the second is
 * not, and the server has promoted (it accepts writes).
 */
import { assertEquals } from "@std/assert";

const IMAGE = "postgres:16-alpine";
const SCRIPT = new URL("../../scripts/deploy/pitr-prepare.sh", import.meta.url)
  .pathname;

async function sh(args: string[]): Promise<{ code: number; out: string }> {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(output.stdout) +
    new TextDecoder().decode(output.stderr);
  return { code: output.code, out };
}

async function must(args: string[]): Promise<string> {
  const { code, out } = await sh(args);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}: ${out}`);
  return out.trim();
}

const psql = (name: string, sql: string) =>
  must(["docker", "exec", name, "psql", "-U", "postgres", "-Atqc", sql]);

async function waitReady(name: string, sql = "select 1"): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const { code } = await sh([
      "docker",
      "exec",
      name,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-Atqc",
      sql,
    ]);
    if (code === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} never answered ${sql}`);
}

Deno.test("a prepared data directory replays archived WAL to the target minute and promotes", async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const source = `pitr-src-${id}`;
  const target = `pitr-dst-${id}`;
  const root = await Deno.makeTempDir({ prefix: "pitr-" });
  try {
    await Deno.mkdir(`${root}/wal`);
    await Deno.mkdir(`${root}/base`);
    await Deno.mkdir(`${root}/data`);
    await Deno.chmod(root, 0o777);
    await must([
      "docker",
      "run",
      "-d",
      "--name",
      source,
      "-e",
      "POSTGRES_PASSWORD=pitr",
      "-v",
      `${root}/wal:/wal`,
      "-v",
      `${root}/base:/base`,
      IMAGE,
      "-c",
      "wal_level=replica",
      "-c",
      "archive_mode=on",
      "-c",
      "archive_timeout=60",
      "-c",
      "archive_command=test ! -f /wal/%f && cp %p /wal/%f",
    ]);
    await must([
      "docker",
      "exec",
      source,
      "chown",
      "postgres",
      "/wal",
      "/base",
    ]);
    await waitReady(source);
    await psql(
      source,
      "create table marks (label text primary key, at timestamptz default clock_timestamp())",
    );
    await must([
      "docker",
      "exec",
      "-u",
      "postgres",
      source,
      "pg_basebackup",
      "-U",
      "postgres",
      "-D",
      "/base/out",
      "-F",
      "tar",
      "-X",
      "none",
    ]);
    await psql(source, "insert into marks (label) values ('before')");
    await new Promise((r) => setTimeout(r, 1500));
    const between = await psql(
      source,
      "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
    );
    await new Promise((r) => setTimeout(r, 1500));
    await psql(source, "insert into marks (label) values ('after')");
    await psql(source, "select pg_switch_wal()");
    // The archiver copies the closed segment; wait until it reports it.
    for (let i = 0; i < 60; i++) {
      const failed = await psql(
        source,
        "select last_archived_wal is not null and last_archived_time > now() - interval '1 minute' from pg_stat_archiver",
      );
      if (failed === "t") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await must(["docker", "stop", source]);

    // Prepare inside the postgres image, as root, so files belong to uid 70.
    await must([
      "docker",
      "run",
      "--rm",
      "-v",
      `${root}:/r`,
      "-v",
      `${SCRIPT}:/pitr-prepare.sh:ro`,
      "--entrypoint",
      "bash",
      IMAGE,
      "/pitr-prepare.sh",
      "/r/base/out/base.tar",
      "/r/data/pg",
      between,
      "/wal",
    ]);
    await must([
      "docker",
      "run",
      "-d",
      "--name",
      target,
      "-v",
      `${root}/data/pg:/var/lib/postgresql/data`,
      "-v",
      `${root}/wal:/wal:ro`,
      IMAGE,
    ]);
    await waitReady(target, "select pg_is_in_recovery() = false or null");
    for (let i = 0; i < 60; i++) {
      if (await psql(target, "select pg_is_in_recovery()") === "f") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assertEquals(await psql(target, "select pg_is_in_recovery()"), "f");
    assertEquals(
      await psql(target, "select string_agg(label, ',') from marks"),
      "before",
    );
    await psql(
      target,
      "insert into marks (label) values ('written after promote')",
    );
  } catch (error) {
    console.error((await sh(["docker", "logs", "--tail", "40", target])).out);
    throw error;
  } finally {
    await sh(["docker", "rm", "-fv", source, target]);
    await sh([
      "docker",
      "run",
      "--rm",
      "-v",
      `${root}:/r`,
      "--entrypoint",
      "rm",
      IMAGE,
      "-rf",
      "/r/wal",
      "/r/base",
      "/r/data",
    ]);
    await Deno.remove(root, { recursive: true });
  }
});
