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

## Build the unsigned package

From `apps/desktop`, with the build image and its caches in place (see the spike notes in the #77
thread):

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
3. Sign each release file with `cargo tauri signer sign`, and publish an `latest.json` that names the
   version, the file's address and its signature.
4. Run `e2e/update.sh` again, so the build with the real public key is checked to refuse a file signed by
   any other key.

Until step 2 is done, the app accepts nothing, which is the safe state.
