# Packaging the desktop app, and checking its updates

How the Bakery desktop app is packaged for Linux today, how it decides whether to trust an update, and
what the owner has to do before a signed release exists. This page is for whoever builds or releases
the app.

## What exists now

- **An unsigned Linux package** (`.deb`) built from `apps/desktop`. It names its two needs (the
  system's web view and GTK), installs the program under `usr/bin`, and registers the `bakery://`
  scheme so the browser can hand a sign-in back to the app.
- **Update checking that fails closed.** The app trusts an update only when its signature checks
  against a public key built into the app. The key in the repository is a placeholder that checks
  nothing, so until the owner's key is built in, the app accepts no update.

## What does not exist yet

- A **signed release**. The signing key is held by the owner and is never in the repository, in CI or in
  any file a person on the team can read. Nothing here asks for it.
- A **hosted update address**. The app is told where to ask for updates when the release is set up;
  today only the test run points it anywhere.
- Packages for **macOS and Windows**, and an installer format the updater can install in place on
  Linux. The package here is a `.deb`, which a person installs with their system's package tool.
- The app **installing** an update. What is proven is that a download is accepted or refused on its
  signature; showing the person that an update exists, and replacing the running app, is a later piece
  with its own design.

## Set up the build image and its caches (once)

The checks run inside a Linux container, so they build the same way on any computer that has Docker.
The container recipe is `apps/desktop/e2e/Dockerfile`. The caches are folders on your computer, so a
second run does not download and compile everything again.

```sh
docker build -t bakery-spike77-linux apps/desktop/e2e
export SPIKE_CACHE=$HOME/bakery-desktop-cache      # any folder you can write to
mkdir -p "$SPIKE_CACHE"/{cli,registry,git,target-update}
docker run --rm -v "$SPIKE_CACHE/cli:/cli" bakery-spike77-linux \
  cargo install tauri-cli --version 2.12.6 --locked --root /cli
```

The scripts read the image name from `DESKTOP_IMAGE` (default `bakery-spike77-linux`) and the cache folder
from `SPIKE_CACHE`. `registry` and `git` hold downloaded crates, `target-update` holds the compiled app,
and `cli` holds the Tauri command line the scripts run inside the container. The image is for Linux on the
processor of the computer that builds it: an arm64 computer makes an arm64 package.

## Build the unsigned package

From `apps/desktop`:

```sh
bash e2e/package.sh <output dir>
```

It builds the package, then checks that the package names its needs, installs the program, registers the
scheme, passes the address it is given on to the app, and that the unpacked program runs. The result is
in `<output dir>/package-results.txt`, and the package itself is copied next to it.

## Check that updates are verified

```sh
bash e2e/update.sh <output dir>
```

It makes two throwaway test keys, builds the app twice (the placeholder key, and a test key), serves
four update files from this computer, and asks each build for them:

| the update | the app with the test key built in | the app with the placeholder key |
| --- | --- | --- |
| correctly signed | accepts it | refuses it |
| changed after it was signed | refuses it | |
| signed by another key | refuses it | |
| the version it already has | says it is up to date | |

The test keys exist only inside that run. The release key plays no part in it.

## What the owner does to turn signed updates on

1. Make a key pair with `cargo tauri signer generate`, and keep the private half where only the owner
   can read it.
2. Put the public half in `plugins.updater.pubkey` of `apps/desktop/src-tauri/tauri.conf.json` in place of
   the placeholder, and the address the app should ask in `plugins.updater.endpoints`.
3. Sign each release file with `cargo tauri signer sign`, and publish a `latest.json` that names the
   version, the file's address and its signature.
4. Run `e2e/update.sh` again, so the build with the real public key is checked to refuse a file signed by
   any other key.

Until step 2 is done, the app accepts nothing, which is the safe state.
