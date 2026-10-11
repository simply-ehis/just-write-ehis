"""AI memory sidecar (vendored harness, adapted).

Wraps `harness/memory.py` (vendored from small-model-harness, see
harness/ATTRIBUTION.md) over a private stdio JSON-line pipe. No TCP port,
no HTTP: one JSON request object per line on stdin, one response line on
stdout, diagnostics on stderr (stdout is reserved for frames).

Request:  {"id": 1, "method": "health"|"learn"|"recall"|"redact"|"clear",
           "params": {...}}
Response: {"id": 1, "ok": true, "result": {...}}
        or {"id": 1, "ok": false, "error": "..."}.

Methods (params → result):
  health  {}                  → {"status": "ok", "facts": N}
  learn   {text}              → {"stored": N}     (extract + store facts)
  recall  {q}                 → {"facts": "..."}  (prompt-ready block or "")
  redact  {text}              → {"text": "..."}   (secrets scrubbed)
  clear   {}                  → {"facts": 0}

The launcher sets JWE_MEMORY_TOKEN (still required at startup: the pipe
is private, but the contract keeps old/new builds interchangeable).

Persistence: facts JSON at argv[1]/memory.json (default: this script's
working dir).

Stdlib only — no new requirements.
"""

import json
import os
import sys

HERE = os.environ.get("JWE_SIDECARS_DIR") or os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from harness.memory import SessionMemory, redact_secrets  # noqa: E402

DATA_FILENAME = "memory.json"
AUTH_TOKEN = os.environ.get("JWE_MEMORY_TOKEN", "")


class MemoryStore:
    """SessionMemory plus JSON persistence across sidecar restarts."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, DATA_FILENAME)
        self.mem = SessionMemory()
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                records = json.load(f)
        except (OSError, ValueError):
            return
        for rec in records:
            try:
                fact = self.mem.remember(
                    rec["text"], kind=rec.get("kind", "other")
                )
                if fact is None:
                    continue
                # Restore scoring state without re-deriving importance.
                fact.importance = float(rec.get("importance", fact.importance))
                fact.created_at = float(rec.get("created_at", fact.created_at))
                fact.last_used_at = float(rec.get("last_used_at", fact.last_used_at))
                fact.use_count = int(rec.get("use_count", 0))
            except (KeyError, TypeError, ValueError):
                continue
        # Keep ids unique across restarts.
        if self.mem._facts:
            self.mem._next_id = max(f.id for f in self.mem._facts) + 1

    def save(self) -> None:
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    [
                        {
                            "id": fact.id,
                            "text": fact.text,
                            "kind": fact.kind,
                            "importance": fact.importance,
                            "created_at": fact.created_at,
                            "last_used_at": fact.last_used_at,
                            "use_count": fact.use_count,
                        }
                        for fact in self.mem.facts
                    ],
                    f,
                )
            os.replace(tmp, self.path)
        except OSError as e:
            print(f"[memory] save failed: {e}", file=sys.stderr, flush=True)


STORE: MemoryStore | None = None


def _dispatch(method: str, params: dict) -> dict:
    if method == "health":
        return {"status": "ok", "facts": len(STORE.mem) if STORE else 0}
    if STORE is None:
        raise RuntimeError("store not ready")
    if method == "learn":
        stored = STORE.mem.learn_from_user_text(str(params.get("text", "")))
        STORE.save()
        return {"stored": len(stored)}
    if method == "recall":
        return {"facts": STORE.mem.build_memory_prompt(str(params.get("q", "")))}
    if method == "redact":
        return {"text": redact_secrets(str(params.get("text", "")))}
    if method == "clear":
        STORE.mem.clear()
        STORE.save()
        return {"facts": 0}
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
        f"[memory] stdio sidecar ready ({len(STORE.mem)} facts loaded)",
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
