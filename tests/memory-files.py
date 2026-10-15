"""End-to-end check of the file-based memory sidecar.

Proves the three things the old session-memory blob could not do:
  1. facts actually persist to disk across a restart
  2. recall returns a profile + directory LISTING (not a full dump)
  3. read opens one file on demand, and never-store categories are refused
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
# The sidecar lives in src-tauri/sidecars, not next to this test.
SIDECARS = os.path.normpath(os.path.join(HERE, "..", "src-tauri", "sidecars"))
DATA = tempfile.mkdtemp(prefix="jwe-memtest-")
ENV = dict(os.environ, JWE_MEMORY_TOKEN="tok", JWE_SIDECARS_DIR=SIDECARS)

proc = subprocess.Popen(
    [sys.executable, os.path.join(SIDECARS, "memory_server.py"), DATA],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    env=ENV, text=True, encoding="utf-8",
)


def call(method, **params):
    proc.stdin.write(json.dumps({"id": 1, "method": method, "params": params}) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())["result"]


fails = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (" - " + str(detail) if detail else ""))
    if not ok:
        fails.append(name)


try:
    check("health starts clean", call("health")["status"] == "ok")

    # 1. user-stated facts get filed
    r = call("learn", text="My name is Elena. I always write in British English. "
                          "I'm working on the Nightfall audiobook project.",
             topics={"nightfall": "nightfall"})
    check("learn stores statements", r["stored"] >= 2, f"stored={r['stored']}")
    check("learn routed a topic file", "nightfall.md" in os.listdir(DATA),
          os.listdir(DATA))
    check("learn made a profile", "profile.md" in os.listdir(DATA))

    # 2. never-store categories are REFUSED, not quietly kept
    r = call("learn", text="My card is 4111 1111 1111 1111 and my password=hunter2secret99")
    check("card number refused", r["stored"] == 0 and "never stored" in r["skipped"], r)
    check("refusal explained to the caller", "card" in r["skipped"] or "ID" in r["skipped"], r["skipped"])

    # 3. recall = profile + listing, NOT every fact body
    rec = call("recall", q="what is the nightfall project?")
    facts = rec["facts"]
    check("recall returns a block", bool(facts))
    check("recall includes the listing header", "Memory files available" in facts)
    check("recall includes nightfall in listing", "nightfall.md" in facts)
    check("listing is metadata only (no bodies)", "audiobook" not in facts,
          "topic-file body leaked into the listing")

    # 4. read opens exactly one file on demand
    body = call("read", name="nightfall")["text"]
    check("read returns the file body", "Nightfall audiobook" in body, body[:80])
    check("read has a summary line", body.startswith("summary:"), body[:40])

    # 5. prefetch inlines the matching file for a no-tool-calling model
    pre = call("recall", q="tell me about nightfall", prefetch=True)["facts"]
    check("prefetch inlines the topic file", "Nightfall audiobook" in pre)

    # 6. forget removes a specific line
    check("forget removes matches", call("forget", text="British English")["removed"] >= 1)
    check("forget actually removed it", "British English" not in call("read", name="profile")["text"])

    # 7. persistence across restart
    proc.stdin.close(); proc.wait(timeout=10)
    proc2 = subprocess.Popen(
        [sys.executable, os.path.join(SIDECARS, "memory_server.py"), DATA],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=ENV, text=True, encoding="utf-8",
    )
    proc = proc2
    check("files survive a restart", call("health")["files"] >= 2, call("health"))

    call("clear")
    check("clear empties the folder", os.listdir(DATA) == [], os.listdir(DATA))
finally:
    try:
        proc.kill()
    except Exception:
        pass
    shutil.rmtree(DATA, ignore_errors=True)

print()
print("MEMORY-FILES ALL PASS" if not fails else f"FAILURES: {fails}")
sys.exit(1 if fails else 0)
