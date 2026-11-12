// A worker that never signals READY: start-up hangs.
await new Promise(() => {
  setInterval(() => {}, 1_000);
});
