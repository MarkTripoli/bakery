switch (Deno.args[0]) {
  case "worker": {
    const { createNativeExecutor } = await import(
      "../../apps/worker/src/executor.ts"
    );
    const executor = createNativeExecutor({
      cgroupRoot: Deno.env.get("BAKERY_WORKER_CGROUP_ROOT"),
      stateDir: Deno.env.get("BAKERY_WORKER_STATE_DIR"),
    });
    await executor.initialize();
    console.log("NATIVE_WORKER_CGROUP_AND_BWRAP_PROVED");
    break;
  }
  case "api": {
    const { createDraftIsolation } = await import(
      "../../apps/server/src/modules/knowledge/draft-isolation.ts"
    );
    await createDraftIsolation().initialize("Bakery native deployment probe");
    console.log("NATIVE_API_SYSTEMD_ISOLATION_PROVED");
    break;
  }
  default:
    throw new Error("EXPECTED_API_OR_WORKER_PROBE");
}
