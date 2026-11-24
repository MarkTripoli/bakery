# Starting Bakery for the desktop app

What to do when the Bakery desktop app says "Bakery is not running on this computer". This page is
for the person using the app, and for whoever sets up their computer.

## What the message means

The desktop app is only a window. The Bakery server is a separate program, and the app shows what
that server serves. "Bakery is not running on this computer" means the app asked the server on this
computer, at `http://127.0.0.1:8000`, and nothing answered. The app asks again every 15 seconds, so
once the server is up the window moves on by itself.

## If someone else runs your Bakery

Then the server is not meant to be on this computer. Press **Use a different server**, choose
**Another address** and type the address you were given, for example `https://bakery.example.com`.
The app checks that it is a Bakery server before it switches, and it keeps your sign-in for each
server, so you can switch back without signing in again.

## If you run Bakery on this computer

From a copy of the Bakery source, with Docker and the tools pinned in `.tool-versions` installed:

```sh
pnpm install --frozen-lockfile

export BAKERY_ENV=development
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export INNGEST_EVENT_KEY=local-event-key

scripts/dev/compose-up.sh local-dev postgres redis inngest
set -a; . ./.env.local-dev; set +a

pnpm migrate
pnpm createsuperuser   # the first time only
pnpm dev
```

The README's Quickstart has the same steps with more detail. When the server prints that it is
ready, the app's window moves on within 15 seconds, or sooner if you press **Try again**.

## It still does not answer

- Open `http://127.0.0.1:8000/health` in a browser on this computer. A page of JSON that says
  `"service":"bakery-server"` means the server is running; if the app still says it is not, quit
  and reopen the app.
- If the server runs on another port, start the app with `BAKERY_SERVER` set to its address, or
  choose it under **Use a different server**.
- A firewall or VPN that blocks connections to this computer's own address will also stop the app.
