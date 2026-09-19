"""AI memory sidecar (vendored harness, adapted).

Wraps `harness/memory.py` (vendored from small-model-harness, see
harness/ATTRIBUTION.md) in the same stdlib HTTP shape as stt/tts_server.py.

Endpoints (all JSON):
  GET  /health          → {"status": "ok", "facts": N}
  POST /learn   {text}  → {"stored": N}      (extract + store facts)
  GET  /recall?q=...    → {"facts": "..."}   (prompt-ready block or "")
  POST /redact  {text}  → {"text": "..."}    (secrets scrubbed)
  POST /forget  {id}    → {"forgotten": bool}
  POST /clear           → {"facts": 0}
  GET  /facts           → {"facts": [{id, text, kind, importance, use_count}]}

Persistence: facts JSON at argv[2]/memory.json (default: alongside this
script's working dir). argv[1] is the port, like the other sidecars.

Stdlib only — no new requirements.
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness.memory import SessionMemory, redact_secrets  # noqa: E402

DATA_FILENAME = "memory.json"


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
            print(f"[memory] save failed: {e}", flush=True)


STORE: MemoryStore | None = None


class MemoryHandler(BaseHTTPRequestHandler):
    def log_message(self, _fmt, *_args):
        pass

    def _json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json({"status": "ok", "facts": len(STORE.mem) if STORE else 0})
        elif parsed.path == "/recall":
            q = parse_qs(parsed.query).get("q", [""])[0]
            block = STORE.mem.build_memory_prompt(q) if STORE else ""
            self._json({"facts": block})
        elif parsed.path == "/facts":
            facts = [f.to_dict() for f in STORE.mem.facts] if STORE else []
            self._json({"facts": facts})
        else:
            self._json({"error": "unknown endpoint"}, 404)

    def do_POST(self):
        if STORE is None:
            self._json({"error": "store not ready"}, 500)
            return
        body = self._body()
        if self.path == "/learn":
            stored = STORE.mem.learn_from_user_text(str(body.get("text", "")))
            STORE.save()
            self._json({"stored": len(stored)})
        elif self.path == "/redact":
            self._json({"text": redact_secrets(str(body.get("text", "")))})
        elif self.path == "/forget":
            try:
                forgotten = STORE.mem.forget(int(body.get("id", -1)))
            except (TypeError, ValueError):
                forgotten = False
            STORE.save()
            self._json({"forgotten": forgotten})
        elif self.path == "/clear":
            STORE.mem.clear()
            STORE.save()
            self._json({"facts": 0})
        else:
            self._json({"error": "unknown endpoint"}, 404)


def main():
    global STORE
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8092
    data_dir = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    STORE = MemoryStore(data_dir)
    print(
        f"[memory] AI memory server on http://127.0.0.1:{port} "
        f"({len(STORE.mem)} facts loaded)",
        flush=True,
    )
    server = HTTPServer(("127.0.0.1", port), MemoryHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
