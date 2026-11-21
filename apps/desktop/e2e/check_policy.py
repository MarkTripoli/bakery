#!/usr/bin/env python3
"""Reads what the window reported about the content security policy and checks it.

Each thing the policy must refuse has to have thrown AND raised a security policy violation: the
violation is what proves the policy refused it, not a network or code error. The one server the app
may connect to must not raise a connect violation.
"""
import json
import sys

lines = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
probes = [line["data"] for line in lines if line["event"] == "probe"]
if not probes or "results" not in probes[-1]:
    print("FAIL no probe result was reported:", probes[-1:] or "nothing")
    sys.exit(1)
report = probes[-1]
results = {r["name"]: r for r in report["results"]}
violations = report["violations"]


def violated(directive_prefix, blocked_part):
    return any(
        v["directive"].startswith(directive_prefix) and blocked_part in v["blocked"] for v in violations
    )


checks = [
    ("a fetch to another server is refused", results["fetch-other-server"]["threw"]
     and violated("connect-src", "not-the-server.example")),
    ("a WebSocket to another server is refused", violated("connect-src", "wss://not-the-server.example")),
    ("eval is refused", results["eval"]["threw"] and violated("script-src", "eval")),
    ("the Function constructor is refused", results["function-constructor"]["threw"]),
    ("an inline script does not run", results["inline-script"]["ran"] is False
     and any(v["directive"].startswith("script-src") for v in violations)),
    ("the configured server is not refused by the policy", not violated("connect-src", "127.0.0.1:9")),
]
failed = [name for name, ok in checks if not ok]
for name, ok in checks:
    print(("PASS " if ok else "FAIL ") + name)
if failed:
    print("results:", json.dumps(report["results"]))
    print("violations:", json.dumps(violations))
sys.exit(1 if failed else 0)
