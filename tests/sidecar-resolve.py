"""sidecar-resolve — fail-closed model path checks for stt_server.py /
tts_server.py: traversal rejected, missing explicit picks error (never
silent fallback to bundled), empty/legacy still default.

Loads only the stdlib prefix of each server (constants + resolvers), so
no model weights or native bindings are needed.

Run: python tests/sidecar-resolve.py
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIDECARS = os.path.join(ROOT, "src-tauri", "sidecars")

failures = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def load_prefix(path, stop_marker):
    """Exec the file up to (not incl.) the first line with stop_marker."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    cut = src.index(stop_marker)
    ns = {"__name__": "sidecar_resolve_test", "__file__": path}
    exec(compile(src[:cut], path, "exec"), ns)
    return ns


stt = load_prefix(os.path.join(SIDECARS, "stt_server.py"), "def _find_transcribe_cli")
tts = load_prefix(os.path.join(SIDECARS, "tts_server.py"), "def _find(")

orig_argv = list(sys.argv)

try:
    # ── STT ──
    sys.argv = ["stt_server.py", "8093", ""]
    check("stt empty -> bundled", stt["_resolve_model"]() == stt["DEFAULT_GGUF"])
    sys.argv = ["stt_server.py", "8093", "moonshine-v2-q6"]
    check("stt legacy -> bundled", stt["_resolve_model"]() == stt["DEFAULT_GGUF"])

    for evil in ["../evil.gguf", "..\\evil.gguf", "models/../../etc/passwd",
                 "C:/vault/../secret/x.gguf"]:
        sys.argv = ["stt_server.py", "8093", evil]
        try:
            stt["_resolve_model"]()
            check(f"stt traversal rejected ({evil})", False, "resolved instead of raising")
        except RuntimeError:
            check(f"stt traversal rejected ({evil})", True)

    sys.argv = ["stt_server.py", "8093", "C:/definitely/missing/model.gguf"]
    try:
        stt["_resolve_model"]()
        check("stt missing absolute errors", False, "fell back silently")
    except RuntimeError:
        check("stt missing absolute errors", True)

    sys.argv = ["stt_server.py", "8093", "no-such-model.gguf"]
    try:
        stt["_resolve_model"]()
        check("stt missing bare name errors", False, "fell back silently")
    except RuntimeError:
        check("stt missing bare name errors", True)

    with tempfile.NamedTemporaryFile(suffix=".gguf", delete=False) as f:
        gguf = f.name
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as f:
        onnx = f.name
    try:
        sys.argv = ["stt_server.py", "8093", gguf]
        check("stt explicit existing gguf accepted",
              stt["_resolve_model"]() == os.path.realpath(gguf))
        sys.argv = ["stt_server.py", "8093", onnx]
        try:
            stt["_resolve_model"]()
            check("stt explicit non-gguf rejected", False, "accepted")
        except RuntimeError:
            check("stt explicit non-gguf rejected", True)
    finally:
        os.unlink(gguf)
        os.unlink(onnx)

    # ── TTS ──
    sys.argv = ["tts_server.py", "8094", ""]
    check("tts empty -> vendored", tts["_model_dir"]() == tts["DEFAULT_MODEL_DIR"])
    sys.argv = ["tts_server.py", "8094", "hexgrad/Kokoro-82M"]
    check("tts legacy -> vendored", tts["_model_dir"]() == tts["DEFAULT_MODEL_DIR"])

    for evil in ["../evil", "..\\evil"]:
        sys.argv = ["tts_server.py", "8094", evil]
        try:
            tts["_model_dir"]()
            check(f"tts traversal rejected ({evil})", False, "resolved instead of raising")
        except RuntimeError:
            check(f"tts traversal rejected ({evil})", True)

    sys.argv = ["tts_server.py", "8094", "C:/definitely/missing/bundle"]
    try:
        tts["_model_dir"]()
        check("tts missing dir errors", False, "fell back silently")
    except RuntimeError:
        check("tts missing dir errors", True)

    with tempfile.TemporaryDirectory() as d:
        sys.argv = ["tts_server.py", "8094", d]
        check("tts explicit existing dir accepted",
              tts["_model_dir"]() == os.path.realpath(d))
finally:
    sys.argv = orig_argv

print("SIDECAR-RESOLVE ALL PASS" if not failures else f"SIDECAR-RESOLVE {len(failures)} FAILURE(S)")
sys.exit(1 if failures else 0)
