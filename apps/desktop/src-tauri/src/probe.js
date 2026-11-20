// Run by the policy test only: tries what the content security policy must refuse, and reports which
// of them the browser engine blocked. Not part of the page, and never loaded in normal use.
(async () => {
  const violations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    violations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
  });
  const attempt = async (name, run) => {
    try {
      await run();
      return { name, threw: false };
    } catch (error) {
      return { name, threw: true, error: String(error && error.name) };
    }
  };
  const results = [];
  // A connection to a server that is not the configured one.
  results.push(
    await attempt(
      "fetch-other-server",
      () => fetch("https://not-the-server.example/probe"),
    ),
  );
  results.push(
    await attempt(
      "websocket-other-server",
      () =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket("wss://not-the-server.example/probe");
          socket.onerror = () => reject(new Error("blocked"));
          socket.onopen = () => resolve();
          setTimeout(() => reject(new Error("timeout")), 2000);
        }),
    ),
  );
  // The configured server: the policy lets the connection start (it may still fail for other reasons).
  results.push(
    await attempt("fetch-configured-server", () => fetch("__SERVER__/health")),
  );
  // Code the policy must never run.
  // The probe calls eval and the Function constructor on purpose: the policy must refuse them.
  // deno-lint-ignore no-eval
  results.push(await attempt("eval", () => eval("1 + 1")));
  results.push(
    await attempt("function-constructor", () => new Function("return 1")()),
  );
  const inline = document.createElement("script");
  inline.textContent = "globalThis.__inlineRan = true";
  document.head.append(inline);
  results.push({ name: "inline-script", ran: globalThis.__inlineRan === true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const report = { results, violations };
  globalThis.__TAURI__.core.invoke("probe_result", { result: report });
})();
