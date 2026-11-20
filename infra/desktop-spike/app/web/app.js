// The web view half of the spike: what the shared React UI would do inside the window.
const { invoke } = globalThis.__TAURI__.core;
const { listen } = globalThis.__TAURI__.event;
const log = (m) => {
  document.getElementById("log").textContent += "\n" + m;
};
const report = (event, data = {}) => invoke("report_from_web", { event, data });

let socket = null;
let attempt = 0;

async function bearerFetch(origin, credential) {
  // A cross-origin call from the web view's own origin: does the server answer it?
  try {
    const r = await fetch(origin + "/v1/me", {
      headers: { authorization: "Bearer " + credential },
    });
    await report("fetch_me", { status: r.status, pageOrigin: location.origin });
  } catch (e) {
    await report("fetch_me", { error: String(e), pageOrigin: location.origin });
  }
}

async function connect() {
  // Both the load-time check and the signed-in event may ask: one socket at a time.
  if (socket && socket.readyState <= 1) return;
  const credential = await invoke("socket_credential");
  const origin = await invoke("server_origin");
  if (!credential) {
    await report("no_credential");
    return;
  }
  await bearerFetch(origin, credential);
  // A WebSocket cannot carry the Bakery-Organization-Id header, so the organization goes in the
  // query string. The server does not put one in /v1/me: the app lists the principal's own.
  let organizationId = null;
  try {
    const r = await fetch(origin + "/v1/organizations", {
      headers: { authorization: "Bearer " + credential },
    });
    const page = r.ok ? await r.json() : null;
    organizationId = page?.items?.[0]?.id ?? null;
    await report("organizations", {
      status: r.status,
      found: organizationId !== null,
    });
  } catch (e) {
    await report("organizations", { error: String(e) });
  }
  if (organizationId === null) {
    // The server may be down or restarting: try again with the same backoff as a failed socket.
    attempt += 1;
    setTimeout(connect, Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 8000));
    return;
  }
  const url = origin.replace(/^http/, "ws") + "/v1/events?organizationId=" +
    encodeURIComponent(organizationId);
  attempt += 1;
  const n = attempt;
  // A web view cannot set headers on a WebSocket: the credential travels as a subprotocol.
  socket = new WebSocket(url, [
    "bakery.desktop",
    "bakery.credential." + credential,
  ]);
  let messages = 0;
  socket.onopen = () =>
    report("socket_open", { attempt: n, protocol: socket.protocol });
  socket.onmessage = (ev) => {
    messages += 1;
    if (messages <= 3) {
      let type = "unparsed";
      try {
        type = JSON.parse(ev.data).type ?? "no-type";
      } catch (_) {
        // Not JSON: reported as "unparsed".
      }
      report("socket_message", {
        attempt: n,
        n: messages,
        type,
        bytes: String(ev.data).length,
      });
    }
  };
  socket.onclose = (ev) => {
    report("socket_close", {
      attempt: n,
      code: ev.code,
      wasClean: ev.wasClean,
    });
    // Reconnect with a short backoff, the same way the web app does.
    const delay = Math.min(1000 * 2 ** Math.min(n - 1, 3), 8000);
    setTimeout(connect, delay);
  };
  socket.onerror = () => report("socket_error", { attempt: n });
}

report("webview_loaded", {
  userAgent: navigator.userAgent,
  origin: location.origin,
  hasWebSocket: typeof WebSocket !== "undefined",
  hasFetch: typeof fetch !== "undefined",
}).then(() => log("loaded"));
listen("signed-in", () => {
  log("signed in");
  connect();
});
// The app may have signed in before this page registered the listener above (a restart restores
// the credential in milliseconds), so ask once on load instead of relying on the push alone.
connect();
