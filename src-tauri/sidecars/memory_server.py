"""AI memory sidecar - file-based long-term memory over a private pipe.

Wraps harness/memory_files.py (file-per-topic store; secret redaction from
harness/memory.py) over a private stdio JSON-line pipe. No TCP port, no
HTTP: one JSON request object per line on stdin, one response line on
stdout, diagnostics on stderr (stdout is reserved for frames).

Request:  {"id": 1, "method": ..., "params": {...}}
Response: {"id": 1, "ok": true, "result": {...}}
        or {"id": 1, "ok": false, "error": "..."}.

Methods (params -> result):
  health    {}                 -> {"status": "ok", "files": N}
  learn     {text, topics?}    -> {"stored": N, "skipped": "..."}
  recall    {q, prefetch?}    -> {"facts": "<profile + listing>"}
  read      {name}             -> {"name": ..., "text": "<file body>"}
  listing   {}                 -> {"files": [{name, summary}, ...]}
  forget    {text}             -> {"removed": N}
  redact    {text}             -> {"text": "..."}
  clear     {}                 -> {"files_removed": N}

recall deliberately returns the profile plus a directory listing, NOT every
fact: the listing is metadata only, and read is how a file gets opened. Pass
prefetch=true for the bundled model, which has no tool calling, so the
sidecar keyword-matches and inlines the relevant file instead.

The launcher sets JWE_MEMORY_TOKEN (still required at startup: the pipe is
private, but the contract keeps old/new builds interchangeable).

Persistence: one small .md file per topic under argv[1] (default: this
script working dir), plus profile.md.

Stdlib only - no new requirements.
"""


import json
import os
import sys

HERE = os.environ.get("JWE_SIDECARS_DIR") or os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from harness.memory import redact_secrets  # noqa: E402
from harness.memory_files import MemoryStore  # noqa: E402

AUTH_TOKEN = os.environ.get("JWE_MEMORY_TOKEN", "")


STORE: MemoryStore | None = None


def _dispatch(method: str, params: dict) -> dict:
    """Dispatch a sidecar request.

    `recall` now returns the *context block* (profile + directory listing)
    rather than a flat dump of every fact: the listing tells the model what
    exists, and `read` is how it opens one. That keeps a small model's
    context budget spent on the conversation instead of on memory.
    """
    if method == "health":
        return {"status": "ok", "files": len(STORE.listing()) if STORE else 0}
    if STORE is None:
        raise RuntimeError("store not ready")
    if method == "learn":
        return STORE.learn(str(params.get("text", "")), params.get("topics"))
    if method == "recall":
        q = str(params.get("q", ""))
        block = STORE.context_block(q)
        # The bundled model cannot call tools, so pre-open the one or two
        # files whose topic overlaps the query instead of trusting it to
        # ask. Providers with tool support use the listing alone.
        extra = []
        if params.get("prefetch"):
            for name in STORE.matching(q):
                body = STORE.read(name).strip()
                if body:
                    extra.append(f"--- {name}.md ---\n{body}")
        facts = "\n\n".join([block] + extra)
        return {"facts": facts, "files": len(STORE.listing())}
    if method == "read":
        return {"name": str(params.get("name", "")), "text": STORE.read(str(params.get("name", "")))}
    if method == "forget":
        return STORE.forget(str(params.get("text", "")))
    if method == "listing":
        return {"files": [f.to_dict() for f in STORE.listing()]}
    if method == "redact":
        return {"text": redact_secrets(str(params.get("text", "")))}
    if method == "clear":
        return STORE.clear()
    raise ValueError(f"unknown method: {method}")


def _write(out, obj: dict) -> None:
    out.write(json.dumps(obj) + "\n")
    out.flush()


def main():
    global STORE
    if not AUTH_TOKEN:
        raise RuntimeError("JWE_MEMORY_TOKEN is required")
    data_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    out = sys.stdout
    sys.stdout = sys.stderr  # keep stdout pure frames; prints become logs
    STORE = MemoryStore(data_dir)
    print(
        f"[memory] stdio sidecar ready ({len(STORE.listing())} topic files in {data_dir})",
        flush=True,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            result = _dispatch(str(req.get("method", "")), req.get("params") or {})
            _write(out, {"id": rid, "ok": True, "result": result})
        except Exception as e:
            _write(out, {"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
