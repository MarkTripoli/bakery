#!/usr/bin/env python3
"""Seed the first Bakery admin through the supported `createsuperuser` task.

`createsuperuser` refuses a non-TTY stdin on purpose and this script does not
weaken that: it drives the real task through a private local pseudo-terminal,
reaching the server either with `railway ssh` or with `docker compose exec`.

Safety properties
  * The password is generated here (secrets.token_urlsafe), written once to a
    0600 credentials file and typed into the terminal. It is never put on a
    command line or printed, and the terminal transcript is never printed or
    stored: only an exit code, a prompt count and fixed non-secret markers.
  * Before touching anything it runs `server-entrypoint.sh envcheck` through the
    same transport and refuses unless the required variable names are set and
    BAKERY_PUBLIC_BASE_URL has the same origin as --url.
  * It refuses unless GET <url>/v1/installation/status says bootstrapped:false,
    and it confirms bootstrapped:true afterwards.
  * An existing credentials file is reused only when it is private, not a
    symlink, owned by this user and still marked `pending`.

Examples
  seed-admin.py --transport railway --project <id> --environment <id> \
      --service <api service id> --url https://bakery.marktrip.dev \
      --credentials ~/.local/state/bakery/railway-qa/admin-credentials.json
  seed-admin.py --transport compose --compose-file infra/railway/local-proof/compose.yaml \
      --compose-project bakery-railway-qa-proof --compose-env-file <env> \
      --url https://bakery-qa.localhost:<port> --connect 127.0.0.1 --insecure \
      --credentials ~/.local/state/bakery/railway-qa/local-proof-admin.json
"""
import argparse
import errno
import http.client
import json
import os
import pty
import re
import secrets
import select
import signal
import socket
import ssl
import stat
import subprocess
import sys
import termios
import time
import urllib.parse
from pathlib import Path

ENTRYPOINT = "/workspace/infra/railway/server-entrypoint.sh"
REQUIRED_NAMES = (
    "DATABASE_URL",
    "BAKERY_APP_DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BAKERY_PUBLIC_BASE_URL",
    "BAKERY_ENV",
)
DEFAULT_EMAIL = "admin@bakery-qa.local"
DEFAULT_DISPLAY_NAME = "Bakery QA Admin"
COMPLETED_MARKERS = (
    "Superuser bootstrap complete.",
    "Superuser bootstrap already complete.",
)
OPERATIONAL_DEADLINE_SECONDS = 240
PREFLIGHT_DEADLINE_SECONDS = 120
SAFE_ARGUMENT = re.compile(r"^[A-Za-z0-9._:/@=,+-]+$")


class Refusal(Exception):
    """A deliberate refusal; the message is fixed, non-secret text."""


def refuse(message):
    raise Refusal(message)


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--transport", choices=("compose", "railway"), required=True)
    parser.add_argument("--url", required=True, help="public origin of the web tier")
    parser.add_argument("--credentials", required=True, help="credentials file to create (0600)")
    parser.add_argument("--email", default=DEFAULT_EMAIL)
    parser.add_argument("--display-name", default=DEFAULT_DISPLAY_NAME)
    parser.add_argument("--connect", help="connect to this address instead of resolving the URL host")
    parser.add_argument("--insecure", action="store_true", help="skip TLS verification (local proof CA only)")
    railway = parser.add_argument_group("railway transport")
    railway.add_argument("--project")
    railway.add_argument("--environment")
    railway.add_argument("--service", help="API service id or name")
    compose = parser.add_argument_group("compose transport")
    compose.add_argument("--compose-file")
    compose.add_argument("--compose-project")
    compose.add_argument("--compose-env-file")
    compose.add_argument("--compose-service", default="api")
    arguments = parser.parse_args(argv)
    for name in ("project", "environment", "service", "compose_file", "compose_project",
                 "compose_env_file", "compose_service"):
        value = getattr(arguments, name)
        if value is not None and not SAFE_ARGUMENT.match(value):
            refuse(f"ARGUMENT_REJECTED:{name}")
    if arguments.transport == "railway":
        missing = [n for n in ("project", "environment", "service") if not getattr(arguments, n)]
        if missing:
            refuse("RAILWAY_ARGUMENTS_REQUIRED:" + ",".join(missing))
    else:
        missing = [n for n in ("compose_file", "compose_project", "compose_env_file")
                   if not getattr(arguments, n)]
        if missing:
            refuse("COMPOSE_ARGUMENTS_REQUIRED:" + ",".join(missing))
    parsed = urllib.parse.urlsplit(arguments.url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") \
            or parsed.query or parsed.fragment or parsed.username:
        refuse("URL_MUST_BE_AN_HTTPS_ORIGIN")
    if arguments.insecure and not (arguments.connect or parsed.hostname.endswith(".localhost")):
        refuse("INSECURE_ONLY_FOR_LOCALHOST")
    return arguments


def origin_of(url):
    parsed = urllib.parse.urlsplit(url)
    port = parsed.port or 443
    return f"{parsed.scheme}://{parsed.hostname.lower()}:{port}"


def transport_command(arguments, remote_arguments, terminal):
    """Command that runs `server-entrypoint.sh <remote_arguments>` in the API."""
    remote = ["bash", ENTRYPOINT, *remote_arguments]
    if arguments.transport == "railway":
        return ["railway", "ssh", "-p", arguments.project, "-e", arguments.environment,
                "-s", arguments.service, "--", *remote]
    command = ["docker", "compose", "--profile", "*", "-p", arguments.compose_project,
               "--env-file", arguments.compose_env_file, "-f", arguments.compose_file,
               "exec"]
    if not terminal:
        command.append("-T")
    return [*command, arguments.compose_service, *remote]


def transport_environment(arguments):
    environment = dict(os.environ)
    if arguments.transport == "railway":
        environment.setdefault("RAILWAY_CALLER", "skill:use-railway@1.7.0")
    return environment


def run_captured(arguments, remote_arguments):
    """Run a non-interactive remote command; return (exit, stdout)."""
    try:
        completed = subprocess.run(
            transport_command(arguments, remote_arguments, terminal=False),
            stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=PREFLIGHT_DEADLINE_SECONDS, env=transport_environment(arguments),
        )
    except subprocess.TimeoutExpired:
        refuse("PREFLIGHT_TIMEOUT")
    return completed.returncode, completed.stdout


def preflight(arguments):
    code, output = run_captured(arguments, ["envcheck"])
    if code != 0:
        refuse(f"ENVCHECK_FAILED:exit={code}")
    state = dict(line.split("=", 1) for line in output.splitlines()
                 if re.fullmatch(r"[A-Z0-9_]+=(set|missing)", line))
    missing = [name for name in REQUIRED_NAMES if state.get(name) != "set"]
    if missing:
        refuse("REQUIRED_VARIABLES_MISSING:" + ",".join(missing))
    code, output = run_captured(arguments, ["envcheck", "--show-public", "BAKERY_PUBLIC_BASE_URL"])
    match = re.fullmatch(r"BAKERY_PUBLIC_BASE_URL=(\S+)", output.strip())
    if code != 0 or not match:
        refuse("PUBLIC_BASE_URL_UNREADABLE")
    if origin_of(match.group(1)) != origin_of(arguments.url):
        refuse("PUBLIC_BASE_URL_ORIGIN_MISMATCH")


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to --connect while keeping the URL host for SNI and Host."""

    def __init__(self, *args, connect_address=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._connect_address = connect_address

    def connect(self):
        if not self._connect_address:
            return super().connect()
        sock = socket.create_connection((self._connect_address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def installation_status(arguments):
    parsed = urllib.parse.urlsplit(arguments.url)
    context = ssl.create_default_context()
    if arguments.insecure:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    connection = PinnedHTTPSConnection(parsed.hostname, parsed.port or 443, timeout=20,
                                       context=context, connect_address=arguments.connect)
    try:
        connection.request("GET", "/v1/installation/status", headers={"Accept": "application/json"})
        response = connection.getresponse()
        body = response.read(65536)
    except (OSError, http.client.HTTPException):
        refuse("STATUS_UNREACHABLE")
    finally:
        connection.close()
    if response.status != 200:
        refuse(f"STATUS_HTTP_{response.status}")
    try:
        bootstrapped = json.loads(body).get("bootstrapped")
    except ValueError:
        refuse("STATUS_NOT_JSON")
    if not isinstance(bootstrapped, bool):
        refuse("STATUS_SHAPE_UNEXPECTED")
    return bootstrapped


def ensure_private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        refuse("CREDENTIALS_DIRECTORY_UNSAFE")
    if info.st_mode & 0o077:
        os.chmod(path, 0o700)


def write_private_json(path, value, exclusive):
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_EXCL if exclusive else os.O_TRUNC)
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def load_or_create_identity(arguments):
    path = Path(arguments.credentials)
    ensure_private_directory(path.parent)
    if os.path.lexists(path):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) \
                or info.st_uid != os.getuid() or info.st_mode & 0o077:
            refuse("CREDENTIALS_FILE_NOT_PRIVATE")
        identity = json.loads(path.read_text(encoding="utf-8"))
        if identity.get("setup_state") != "pending" or identity.get("email") != arguments.email \
                or identity.get("url") != arguments.url:
            refuse("CREDENTIALS_FILE_NOT_A_PENDING_SETUP")
        return path, identity
    identity = {
        "url": arguments.url,
        "email": arguments.email,
        "display_name": arguments.display_name,
        "password": secrets.token_urlsafe(32),
        "setup_state": "pending",
    }
    write_private_json(path, identity, exclusive=True)
    return path, identity


def drive_createsuperuser(arguments, identity):
    """Answer the four prompts on a private pty. Returns a non-secret summary."""
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    process = subprocess.Popen(
        transport_command(arguments, ["createsuperuser"], terminal=True),
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        env=transport_environment(arguments),
    )
    os.close(slave)
    questions = [
        ("Email:", identity["email"]),
        ("Display name:", identity["display_name"]),
        ("Password: ", identity["password"]),
        ("Password (again): ", identity["password"]),
    ]
    raw = bytearray()
    pending = ""
    answered = 0
    interrupted = False
    deadline = time.monotonic() + OPERATIONAL_DEADLINE_SECONDS
    exit_code = None
    try:
        while True:
            if time.monotonic() >= deadline:
                interrupted = True
                os.killpg(process.pid, signal.SIGTERM)
                break
            readable, _, _ = select.select([master], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                raw.extend(chunk)
                pending += chunk.decode("utf-8", errors="replace")
                if answered < len(questions) and questions[answered][0] in pending:
                    marker, answer = questions[answered]
                    pending = pending.split(marker, 1)[1]
                    os.write(master, (answer + "\n").encode("utf-8"))
                    answered += 1
            elif process.poll() is not None:
                break
        try:
            exit_code = process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            interrupted = True
            os.killpg(process.pid, signal.SIGKILL)
            exit_code = process.wait(timeout=10)
    finally:
        os.close(master)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    transcript = raw.decode("utf-8", errors="replace")
    summary = {
        "exit": exit_code,
        "terminal_prompts_answered": answered,
        "completed_marker": any(marker in transcript for marker in COMPLETED_MARKERS),
        "operational_timeout": interrupted,
    }
    if exit_code != 0 or not summary["completed_marker"]:
        # Fixed error identifiers only, never transcript text.
        summary["error_codes"] = sorted(set(re.findall(r"\b(?:AUTH|STATE)_[A-Z_]+\b", transcript)))
    del raw, transcript, pending
    return summary


def main(argv):
    arguments = parse_arguments(argv)
    preflight(arguments)
    if installation_status(arguments) is not False:
        refuse("INSTALLATION_ALREADY_BOOTSTRAPPED")
    path, identity = load_or_create_identity(arguments)
    summary = drive_createsuperuser(arguments, identity)
    ok = (summary["exit"] == 0 and summary["completed_marker"]
          and summary["terminal_prompts_answered"] == 4 and not summary["operational_timeout"])
    bootstrapped = None
    if ok:
        bootstrapped = installation_status(arguments)
        ok = bootstrapped is True
    if ok:
        identity["setup_state"] = "complete"
        write_private_json(path, identity, exclusive=False)
    result = {
        "transport": arguments.transport,
        "url": arguments.url,
        "email": identity["email"],
        "credentials_file": str(path),
        "bootstrapped_after": bootstrapped,
        "setup_state": identity["setup_state"],
        **summary,
    }
    print(json.dumps(result, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Refusal as error:
        print(json.dumps({"refused": str(error)}), file=sys.stderr)
        sys.exit(2)
