# The desktop app's keyring on Linux

What to do when the Bakery desktop app says "Bakery could not save your sign-in". This page is for
the person using the app, and for whoever sets up their computer.

## Why the app needs a keyring

After you confirm a sign-in in the browser, the app keeps that sign-in in your computer's secret
store, called a keyring, so you do not have to sign in every time you open it. The app never keeps
the sign-in in a plain file. If there is no keyring to put it in, the app says so, drops the
sign-in, and you sign in again each time until a keyring is running.

On Linux the keyring is a program that answers on your session's D-Bus under the name
`org.freedesktop.secrets` (the Secret Service). Most desktop sessions start one for you. A minimal
window manager, a remote session or a container usually does not.

## Check whether you have one

In a terminal, in the same session as the app:

```sh
secret-tool store --label=test service bakery-test username check <<< "x" && echo "a keyring answered"
secret-tool clear service bakery-test username check
```

`secret-tool` comes with `libsecret-tools` (Debian and Ubuntu) or `libsecret` (Fedora). If the first
command prints "a keyring answered", the app can save its sign-in. If it fails, or waits for a
password prompt that never appears, start or unlock a keyring as below.

## Start or unlock a keyring

**GNOME Keyring.** This is the one the Bakery team has tested.

1. Install `gnome-keyring` if it is missing.
2. In a full GNOME session it starts and unlocks when you sign in to the computer. If it is locked,
   open **Passwords and Keys** (Seahorse), right-click the **Login** keyring and choose **Unlock**.
3. In a session that does not start it for you, start it with your login password and keep it
   running:

   ```sh
   printf '%s' "your login password" | gnome-keyring-daemon --unlock --daemonize --components=secrets
   ```

   A keyring needs a real password. One with an empty password is not created.

**KDE and others.** The app works with any program that provides the Secret Service. KDE's wallet
and KeePassXC can do it when their Secret Service setting is turned on. The Bakery team has not
tested them, so follow their own documentation.

After the keyring is running, press **Sign in with your browser** again.

## If the keyring refuses the sign-in

Bakery tries the keyring before it asks the server for a sign-in, so a computer with no keyring never
makes the server issue one nobody holds. If the keyring fails in the instant after that check, Bakery
ends the unused sign-in on the server before it shows this window. If the server does not answer, the
window says the sign-in may still be listed under **Active sessions** in Account and security on the
web as "Bakery app", and you can revoke it there.

## What Bakery keeps, and where

- The sign-in the server issued to this app, in the keyring, under the service name
  `bakery-desktop` and your server's address.
- Nothing about it in any file, log or report the app writes.

To remove a kept sign-in, sign out in the app, or revoke **Bakery app** under **Active sessions** in
Account and security on the web.
