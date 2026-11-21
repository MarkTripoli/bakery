# Desktop compatibility spike (#77, slice 0)

Question from [08-desktop.md](../technical-design/08-desktop.md): is Tauri good enough for the shared
Bakery client, or do we fall back to Electron, and on which operating systems?

## Recommendation

**Use Tauri 2 for the desktop client on macOS, Windows and Linux. Do not take the Electron fallback.**

Nothing the spike tried needed a feature the operating system's web view lacks. Every check that could
fail a webview passed on Linux (WebKitGTK): bearer calls from a custom origin, a WebSocket that carries
its credential as a subprotocol, reconnect, deep links, a second launch, and the OS secret store.

Two things are **not** proven, and the recommendation depends on them staying cheap to check:

- **macOS and Windows were not run.** The rig has no such host. Native macOS/Windows proof deferred: no
  host in rig. What is proven for them is the platform decision logic (unit tests) and the contract
  between the app's declared constants and the server (a test on any host). Slice 1 should start by
  running the same scenario on a Mac and a Windows machine before any app code builds on this.
- **Linux was run on aarch64 only**, in a container with a virtual display (Xvfb), not on a desktop.

**Switch to Electron only if** a native run shows one of these failing in WKWebView or WebView2: the
credential-as-subprotocol WebSocket, the cross-origin bearer call, or deep-link delivery to a running app.
They are the three places a system web view differs most from a bundled Chromium.

## Which operating systems

| OS | Web view | Status |
|---|---|---|
| Linux | WebKitGTK 4.1 | Proven in the spike (aarch64). Needs a running Secret Service (GNOME Keyring was the one tested) and a registered `bakery://` handler. |
| macOS | WKWebView | Not run. The scheme is declared in the app bundle, not registered at run time. |
| Windows | WebView2 | Not run. The web view's origin is `http://tauri.localhost`; the server accepts it. |

Ship macOS and Windows first. Linux works, but its prerequisites (below) make it the one most likely to
need support; treat it as supported with a stated requirement, not as a default.

## What ran, and where

Linux aarch64, Debian 12 container, WebKitGTK 2.50.6, Tauri 2.12.7 (deep-link 2.6.3, single-instance 2.5.5,
opener 2.7.3), `keyring` 3.6.3, a real Bakery server and Postgres 16 started for the run, Xvfb, GNOME
Keyring, D-Bus. Harness at `infra/desktop-spike/`, run through the db-slot queue.

Final run, harness head `b14c7e94`: **32 passed, 0 failed**, nothing left running afterwards.

| Area | Proven on Linux |
|---|---|
| Sign-in | PKCE (S256) request, confirm page, the done page links back on the redirect the app opened with, code exchanged with the verifier. Both redirects: the `bakery://auth/callback` app link and a loopback listener. |
| Replay | A second delivery of the same callback is rejected: nothing is pending. |
| Credential at rest | Stored in the OS secret store and read back with `secret-tool`. It appears in no report, log, file or process argument. |
| Restart | A later launch restores the credential and connects with no new sign-in. |
| Refused credential | A credential the server no longer accepts is told apart from an unreachable server, and removed. |
| Web view to server | A `fetch` with a bearer from `tauri://localhost` succeeds (CORS). |
| Live socket | The web view opens `/v1/events`, the server selects `bakery.desktop`, a `hello` event arrives. The credential is never echoed back. |
| Reconnect | The socket closes when the server stops, and the web view reconnects by itself with the same credential when it returns (fifth attempt). |
| Single instance | A second launch is forwarded to the running instance. |

Limits of the harness, so the table is not read as more than it is: the container has no browser, so the
"asked the OS to open the system browser" check records that the app asked (the launcher itself fails);
the harness opens the confirm page itself. The `bakery://` link is delivered with `gio open`. WebKit's sandbox is turned off in the container.

## Server gaps found, and fixed in this slice

1. **No CORS for the web view's origin.** The first real run failed the cross-origin bearer call. The
   server now answers preflights and calls from the desktop web view origins and no others
   (`BAKERY_DESKTOP_ORIGINS`, validated in the runtime config: unset allows `tauri://localhost`,
   `http://tauri.localhost` and `https://tauri.localhost`; an empty value allows none; an operator can
   narrow the list and never widen it). It echoes the origin, never `*`, never allows credentials, and
   leaves WebSocket upgrades alone. The desktop origins are not in the cookie allow-list (a config test pins that), so the cookie origin guard still refuses them.
2. **The socket needs an organization, and a web view cannot send a header.** The server was right to
   refuse (`403 scope-required`). It already reads `?organizationId=`, so no server change was needed:
   the client lists its organizations (`GET /v1/organizations`) with the bearer and puts the id in the
   address. The handshake with it gets `101` and selects `bakery.desktop`.

## Client rules the spike found

- **Ask on load as well as listening.** A restart restores the credential in about 100 ms, before the
  page has registered its `signed-in` listener, so the push is lost. The web view must ask for session
  state when it loads and then listen.
- **Retry the lookups, not only the socket.** When the server is down the organization lookup fails too;
  a client that retries only a failed socket never comes back.
- **Append each report line in one write.** Two reporters interleaved small writes and tore a line. This
  is a harness lesson, but any app log with two writers has the same trap.
- **Linux needs an unlocked Secret Service.** With no keyring running, storing the credential fails.
  Slice 1 needs a deliberate answer (a clear message, not a silent fallback to a file).

## Covered without a macOS or Windows host

- `platform.rs` holds the decisions that differ by platform or decide what to accept, free of the Tauri
  runtime: which callbacks are accepted (the app link, or loopback on `127.0.0.1`/`[::1]` with path
  `/callback`, and a code), where the scheme is registered at run time (Linux and Windows, not macOS),
  and the web view's origin per OS. 8 unit tests; 6 deliberate rule breaks were each caught.
- A contract test on the server side (`tests/unit/the-desktop-app-and-the-server-agree-...`) reads the
  app's declared app link, client id, scheme, origins and socket offer and checks them against the
  server's own constants and parser. 5 tests; 6 deliberate drifts were each caught.
- The CORS middleware and its configuration have unit tests: 15, with 8 deliberate breaks caught.

None of this shows that macOS or Windows deliver a deep link or register a scheme. It shows that the
rules the app applies, and the values it shares with the server, are the same on every host.

## Not covered by this slice

Signing and update verification, installers and packaging, macOS and Windows builds, Linux x86_64, a
real desktop session (Wayland or X11), and connection to a separately started local stack. The design
doc lists them for later slices.
