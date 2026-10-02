"""
Moonshine STT Server (torch-free)
================================
Transcribes via in-process `transcribe_cpp` (pip: transcribe-cpp)
against a local Moonshine-base GGUF — no PyTorch, no Ollama, no network
at runtime. A vendored transcribe CLI binary is used as fallback if one
is ever shipped (upstream native archives currently ship DLLs only).

  Model:  memoravox/moonshine-base-gguf · moonshine-base-Q8_0.gguf
  Audio:  16 kHz mono 16-bit WAV (normalized in-process, stdlib only)

Fetch the GGUF with:  python src-tauri/sidecars/fetch_sidecars.py --stt
Runtime dep:          pip install -r src-tauri/sidecars/requirements.txt

Endpoints:
  GET  /health              → {"status": "ok", "model_loaded": bool, "model": str}
  POST /transcribe          → {"text": str}  (one-shot, full WAV audio)
  POST /stream/start        → start accumulating audio chunks
  POST /stream/chunk        → send a chunk ({audio b64, format: wav|pcm_s16})
  POST /stream/stop         → transcribe accumulated audio → {"text": str}

argv: [port] [model]
  port  — default 8090
  model — GGUF path override (paste-to-swap from Settings → AI).
          Bare filename resolves inside <server_dir>/models/.
          Legacy onnx ids (moonshine-v2-q6 …) are ignored with a warning
          and the bundled GGUF is used.
"""

import base64
import io
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import wave
import hmac
from http.server import HTTPServer, BaseHTTPRequestHandler

# Per-launch token supplied by the desktop launcher (sidecar.rs). Required: the
# server refuses to start without it, so it can never fall back to being an open
# loopback endpoint. See SttHandler._authorized.
AUTH_TOKEN = os.environ.get("JWE_SIDECAR_TOKEN", "")

HERE = os.environ.get("JWE_SIDECARS_DIR") or os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")
DEFAULT_GGUF = os.path.join(MODELS_DIR, "moonshine-base-Q8_0.gguf")
TARGET_SR = 16000

# Legacy onnx ids from the torch era — not GGUF paths, ignore them.
_LEGACY_IDS = {"moonshine-v2-q6", "moonshine-v2-q4", "moonshine/tiny", "moonshine-base"}

# transcribe.cpp CLI flag probing (whisper.cpp heritage: -m model, -f file).
_CLI_PROBE = ["--help", "-h", "-?"]
_TIMESTAMP_LINE_RE = re.compile(r"^\s*\[.*?--?>.*?\]")
_TRANSCRIBE_TIMEOUT_S = 180


def _inside_models(path: str) -> bool:
    """True when `path` resolves inside MODELS_DIR (fail-closed root)."""
    try:
        return os.path.commonpath(
            [os.path.realpath(path), os.path.realpath(MODELS_DIR)]
        ) == os.path.realpath(MODELS_DIR)
    except (OSError, ValueError):
        return False


def _resolve_model() -> str:
    override = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else ""
    if not override:
        return DEFAULT_GGUF
    if override in _LEGACY_IDS:
        print(f"[stt] Model alias '{override}' maps to bundled "
              f"{os.path.basename(DEFAULT_GGUF)}.", flush=True)
        return DEFAULT_GGUF
    # Fail closed on traversal: `..` must resolve inside models/.
    if ".." in override.replace("\\", "/").split("/"):
        anchored = override if os.path.isabs(override) else os.path.join(MODELS_DIR, override)
        if not _inside_models(anchored):
            raise RuntimeError(
                f"refusing model path escaping models/: {override!r}")
    if os.path.isabs(override):
        # Explicit absolute pick: must exist and be a .gguf, else hard error
        # (no silent fallback — the Settings field shows an inline error).
        real = os.path.realpath(override)
        if not os.path.isfile(real):
            raise RuntimeError(f"STT model not found: {override!r}")
        if not real.lower().endswith(".gguf"):
            raise RuntimeError(f"STT model must be a .gguf file: {override!r}")
        return real
    candidate = os.path.join(MODELS_DIR, os.path.basename(override))
    if os.path.isfile(candidate):
        return candidate
    raise RuntimeError(
        f"STT model '{override}' not found in models/ "
        f"(expected {os.path.basename(DEFAULT_GGUF)} or a valid .gguf name). "
        f"Clear the field for the bundled default.")


def _find_transcribe_cli() -> str | None:
    """Locate transcribe-cli(.exe) under the server dir (vendored by fetch script)."""
    names = ("transcribe-cli.exe", "transcribe-cli") if os.name == "nt" \
        else ("transcribe-cli", "transcribe-cli.exe")
    for root, _dirs, files in os.walk(HERE):
        for name in names:
            if name in files:
                return os.path.join(root, name)
    return None


def _probe_cli_flags(cli: str) -> tuple[str, str]:
    """Return (model_flag, file_flag) by parsing --help; default whisper-style -m/-f."""
    for flag in _CLI_PROBE:
        try:
            out = subprocess.run([cli, flag], capture_output=True, text=True,
                                 timeout=15).stdout or ""
        except Exception:
            continue
        has_model = ("--model" in out) or re.search(r"(?m)^\s*-m\b", out)
        has_file = ("--file" in out) or re.search(r"(?m)^\s*-f\b", out)
        if has_model or has_file:
            return ("-m" if has_model else "--model",
                    "-f" if has_file else "--file")
    return ("-m", "-f")


# ── WAV normalization (stdlib only) ──────────────────────────────
def _decode_wav_frames(wav_bytes: bytes) -> tuple[bytes, int, int, int]:
    """Return (raw_frames, n_channels, sampwidth, framerate). Raises on bad RIFF."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        return (wf.readframes(wf.getnframes()), wf.getnchannels(),
                wf.getsampwidth(), wf.getframerate())


def _to_mono16(frames: bytes, n_ch: int, sampwidth: int) -> list[int]:
    if sampwidth == 1:
        vals = [b - 128 for b in frames]
        scale = 256.0
    elif sampwidth == 2:
        vals = list(struct.unpack("<%dh" % (len(frames) // 2), frames))
        scale = 1.0
    elif sampwidth == 4:
        vals = [v // 65536 for v in struct.unpack("<%di" % (len(frames) // 4), frames)]
        scale = 1.0
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth * 8}-bit")
    if n_ch == 2:
        vals = [(a + b) // 2 for a, b in zip(vals[0::2], vals[1::2])]
    elif n_ch != 1:
        raise ValueError(f"Unsupported channel count: {n_ch}")
    if sampwidth == 1:
        vals = [int(v * scale) for v in vals]
    return [max(-32768, min(32767, v)) for v in vals]


def _resample(samples: list[int], src_sr: int) -> list[int]:
    if src_sr == TARGET_SR:
        return samples
    ratio = TARGET_SR / src_sr
    out_len = int(len(samples) * ratio)
    out = [0] * out_len
    for i in range(out_len):
        pos = i / ratio
        j = int(pos)
        frac = pos - j
        a = samples[j]
        b = samples[j + 1] if j + 1 < len(samples) else a
        out[i] = int(a + (b - a) * frac)
    return out


def normalize_wav(wav_bytes: bytes) -> bytes:
    """Any PCM WAV → 16 kHz mono 16-bit WAV bytes."""
    if wav_bytes[:4] != b"RIFF":
        raise ValueError("Not a WAV file (missing RIFF header) — "
                         "the app must send real WAV, not webm/opus.")
    frames, n_ch, sampwidth, sr = _decode_wav_frames(wav_bytes)
    if not frames:
        raise ValueError("Empty WAV (no audio frames).")
    samples = _resample(_to_mono16(frames, n_ch, sampwidth), sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(TARGET_SR)
        wf.writeframes(struct.pack("<%dh" % len(samples), *samples))
    return buf.getvalue()


def _strip_timestamps(stdout: str) -> str:
    """whisper-style CLI prints '[00:00:00.000 --> 00:00:05.000] text' lines."""
    lines = []
    for line in stdout.splitlines():
        line = _TIMESTAMP_LINE_RE.sub("", line).strip()
        if line:
            lines.append(line)
    return " ".join(lines).strip()


class _Engine:
    """Moonshine inference. Primary: in-process `transcribe_cpp` (pip);
    fallback: a vendored transcribe CLI binary if one is ever shipped
    (the upstream native archives currently ship DLLs only, no CLI)."""

    def __init__(self):
        self.model = _resolve_model()
        self.backend = "none"
        self.py_model = None
        self.ready_error: str | None = None

        # 1) In-process python bindings (preferred — no binary hunting).
        try:
            import transcribe_cpp  # noqa: F401
            import transcribe_cpp as _tc

            self.py_model = _tc.Model(self.model)
            self.backend = "python"
            print(f"[stt] Ready (in-process): {os.path.basename(self.model)}",
                  flush=True)
            return
        except ImportError:
            pass
        except Exception as e:
            print(f"[stt] transcribe_cpp load failed ({e}) — trying CLI fallback.",
                  flush=True)

        # 2) Subprocess CLI fallback.
        self.cli = _find_transcribe_cli()
        if not self.cli:
            self.ready_error = (
                "No STT engine: `pip install -r src-tauri/sidecars/requirements.txt` "
                "(preferred), or vendor a transcribe CLI under sidecars/."
            )
        elif not os.path.isfile(self.model):
            self.ready_error = (f"STT model not found: {self.model}. "
                                "Run: python src-tauri/sidecars/fetch_sidecars.py --stt")
        else:
            self.model_flag, self.file_flag = _probe_cli_flags(self.cli)
            self.backend = "cli"
            print(f"[stt] Ready (CLI): {os.path.basename(self.cli)} "
                  f"{self.model_flag}/{self.file_flag} "
                  f"+ {os.path.basename(self.model)}", flush=True)

    @property
    def loaded(self) -> bool:
        return self.ready_error is None

    def _run(self, wav_path: str) -> str:
        attempts = [
            [self.cli, self.model_flag, self.model, self.file_flag, wav_path],
            [self.cli, self.model, wav_path],  # positional fallback
        ]
        last_err = ""
        for cmd in attempts:
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True,
                                      timeout=_TRANSCRIBE_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                raise RuntimeError("Transcription timed out (>180s).")
            except OSError as e:
                last_err = str(e)
                continue
            text = _strip_timestamps(proc.stdout or "")
            if text:
                return text
            last_err = (proc.stderr or "").strip().splitlines()[-1:] or [""]
            last_err = last_err[0][:300]
        raise RuntimeError(f"transcribe-cli produced no text. Last error: {last_err}")

    def transcribe_wav(self, wav_bytes: bytes) -> str:
        if not self.loaded:
            raise RuntimeError(self.ready_error)
        normalized = normalize_wav(wav_bytes)
        if self.backend == "python":
            return self._run_python(normalized)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(normalized)
            tmp_path = tmp.name
        try:
            return self._run(tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def _run_python(self, wav_bytes: bytes) -> str:
        """In-process inference: int16 WAV → float32 PCM → session.run."""
        import transcribe_cpp as _tc

        _ = _tc  # bound at init; import here keeps the reference local
        frames, n_ch, sampwidth, _sr = _decode_wav_frames(wav_bytes)
        if sampwidth != 2 or n_ch != 1:
            raise RuntimeError("Internal error: expected normalized 16k mono s16.")
        import struct as _struct

        samples = [
            v / 32768.0
            for v in _struct.unpack("<%dh" % (len(frames) // 2), frames)
        ]
        if not samples:
            raise RuntimeError("Empty audio after normalization.")
        with self.py_model.session() as session:
            result = session.run(samples)
        text = _strip_timestamps((result.text or "").strip())
        if not text:
            raise RuntimeError("Transcription produced no text.")
        return text


_ENGINE: _Engine | None = None
_streaming_wavs: list[bytes] = []


def _engine() -> _Engine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = _Engine()
    return _ENGINE


def _b64_to_wav(b64: str, fmt: str) -> bytes:
    raw = base64.b64decode(b64)
    if fmt == "wav":
        return raw
    if fmt == "pcm_s16":
        # Legacy compat: assume 16 kHz mono int16 LE, wrap as WAV.
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(TARGET_SR)
            wf.writeframes(raw)
        return buf.getvalue()
    raise ValueError(f"Unknown audio format: {fmt}")


# ── HTTP handler ─────────────────────────────────────────────────
class SttHandler(BaseHTTPRequestHandler):
    def log_message(self, _fmt, *_args):
        pass

    def _json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _authorized(self) -> bool:
        """Require the launcher's per-process token.

        Loopback is not a trust boundary: any process running as any local
        account can reach 127.0.0.1, and any website can issue a bodyless POST
        (a CORS-simple request, no preflight) to drive transcription on this
        machine. The desktop launcher mints a token per launch and sends it as
        X-JWE-Sidecar-Token; without a match every route is refused.
        """
        supplied = self.headers.get("X-JWE-Sidecar-Token", "")
        if not AUTH_TOKEN or not hmac.compare_digest(supplied, AUTH_TOKEN):
            self._json({"error": "unauthorized"}, 401)
            return False
        return True

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/health":
            try:
                eng = _engine()
                self._json({"status": "ok" if eng.loaded else "error",
                            "ready": eng.loaded, "model_loaded": eng.loaded,
                            "model": os.path.basename(eng.model),
                            "error": eng.ready_error})
            except Exception as e:
                self._json({"status": "error", "ready": False,
                            "model_loaded": False, "model": "", "error": str(e)})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if not self._authorized():
            return
        routes = {
            "/transcribe": self._transcribe,
            "/stream/start": self._stream_start,
            "/stream/chunk": self._stream_chunk,
            "/stream/stop": self._stream_stop,
        }
        handler = routes.get(self.path)
        if handler:
            handler()
        else:
            self._json({"error": "not found"}, 404)

    def _transcribe(self):
        raw = self._read_body()
        if not raw:
            self._json({"error": "empty body"}, 400)
            return
        try:
            data = json.loads(raw)
            wav = _b64_to_wav(data["audio"], data.get("format", "wav"))
            text = _engine().transcribe_wav(wav)
            self._json({"text": text})
        except Exception as e:
            print(f"[stt] Error: {e}", flush=True)
            self._json({"error": str(e)}, 500)

    def _stream_start(self):
        global _streaming_wavs
        _streaming_wavs = []
        self._json({"status": "streaming"})

    def _stream_chunk(self):
        global _streaming_wavs
        raw = self._read_body()
        try:
            data = json.loads(raw)
            _streaming_wavs.append(_b64_to_wav(data["audio"], data.get("format", "wav")))
            self._json({"ok": True, "chunks": len(_streaming_wavs)})
        except Exception as e:
            self._json({"error": str(e)}, 400)

    def _stream_stop(self):
        global _streaming_wavs
        if not _streaming_wavs:
            self._json({"text": ""})
            return
        # Concatenate frames of all chunks (must share params — enforced here).
        chunks = _streaming_wavs
        _streaming_wavs = []
        try:
            decoded = [_decode_wav_frames(c) for c in chunks]
            params = {(n_ch, sw, sr) for _, n_ch, sw, sr in decoded}
            if len(params) != 1:
                raise ValueError("Stream chunks have mismatched WAV params.")
            frames = b"".join(frames for frames, _, _, _ in decoded)
            n_ch, sw, sr = params.pop()
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(n_ch)
                wf.setsampwidth(sw)
                wf.setframerate(sr)
                wf.writeframes(frames)
            text = _engine().transcribe_wav(buf.getvalue())
            self._json({"text": text})
        except Exception as e:
            print(f"[stt] Stream error: {e}", flush=True)
            self._json({"error": str(e)}, 500)


def main():
    if not AUTH_TOKEN:
        raise RuntimeError("JWE_SIDECAR_TOKEN is required")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    server = HTTPServer(("127.0.0.1", port), SttHandler)
    print(f"[stt] Moonshine STT (transcribe.cpp) on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
