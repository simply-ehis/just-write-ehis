"""
Kokoro TTS Server (torch-free)
==============================
Kokoro v1.0 multi-lang (53 speakers) via sherpa-onnx — no PyTorch, no
HuggingFace download at runtime. The model bundle is vendored locally.

  Bundle: kokoro-multi-lang-v1_0 (model.onnx + voices.bin + tokens.txt
          + espeak-ng-data), fetched with:
            python src-tauri/sidecars/fetch_sidecars.py --tts

Lazy-loads on first synthesis call (A7.6).
Sentence-boundary chunking per A9.3 (~150 tokens/chunk, never mid-sentence).

Endpoints:
  GET  /health        → {"status": "ok", "model_loaded": bool}
  POST /synthesize    → {"audio": base64, "sample_rate": int, "format": "wav"}
  POST /voices        → {"voices": [...]}  (voices for current lang)
  POST /stop          → acknowledges stop (client kills audio)

Synthesize body:
  text, voice (default af_heart), speed (0.5–2.0), lang_code (a/b/j/z/e/f/h/i/p),
  split_pattern, chunk_size.

argv: [port] [model_dir]  — model_dir paste-to-swap from Settings → AI.

Voice → sid map is Kokoro v1.0 (sherpa generate_voices_bin.py order).
Voices absent from the v1.0 bundle (jf_never, fm_alpha, hf_baya, hm_pratik,
it_paola, pm_mario, kf_*, km_*) fall back to af_heart with a logged warning;
Korean has no v1.0 voice — see docs/MODELS.md.
"""

import base64
import glob
import io
import json
import os
import re
import sys
import wave
from http.server import HTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_DIR = os.path.join(HERE, "models", "kokoro-multi-lang-v1_0")

# ── Kokoro v1.0 speaker → sid (53 speakers, sherpa order) ─────────
VOICE_TO_SID = {
    "af_alloy": 0, "af_aoede": 1, "af_bella": 2, "af_heart": 3,
    "af_jessica": 4, "af_kore": 5, "af_nicole": 6, "af_nova": 7,
    "af_river": 8, "af_sarah": 9, "af_sky": 10, "am_adam": 11,
    "am_echo": 12, "am_eric": 13, "am_fenrir": 14, "am_liam": 15,
    "am_michael": 16, "am_onyx": 17, "am_puck": 18, "am_santa": 19,
    "bf_alice": 20, "bf_emma": 21, "bf_isabella": 22, "bf_lily": 23,
    "bm_daniel": 24, "bm_fable": 25, "bm_george": 26, "bm_lewis": 27,
    "ef_dora": 28, "em_alex": 29, "ff_siwis": 30, "hf_alpha": 31,
    "hf_beta": 32, "hm_omega": 33, "hm_psi": 34, "if_sara": 35,
    "im_nicola": 36, "jf_alpha": 37, "jf_gongitsune": 38, "jf_nezumi": 39,
    "jf_tebukuro": 40, "jm_kumo": 41, "pf_dora": 42, "pm_alex": 43,
    "pm_santa": 44, "zf_xiaobei": 45, "zf_xiaoni": 46, "zf_xiaoxiao": 47,
    "zf_xiaoyi": 48, "zm_yunjian": 49, "zm_yunxi": 50, "zm_yunxia": 51,
    "zm_yunyang": 52,
}
FALLBACK_VOICE = "af_heart"

# Voice catalog: lang_code → list of (voice_id, label, gender).
# Only voices present in the v1.0 bundle.
VOICE_CATALOG = {
    "a": [
        ("af_heart",   "Heart (female, warm)",       "female"),
        ("af_bella",   "Bella (female, confident)",  "female"),
        ("af_nicole",  "Nicole (female, soft)",      "female"),
        ("af_sarah",   "Sarah (female, clear)",      "female"),
        ("af_sky",     "Sky (female, bright)",       "female"),
        ("am_adam",    "Adam (male, deep)",          "male"),
        ("am_michael", "Michael (male, neutral)",    "male"),
    ],
    "b": [
        ("bf_emma",   "Emma (female, refined)",  "female"),
        ("bm_george", "George (male, formal)",   "male"),
        ("bm_lewis",  "Lewis (male, casual)",    "male"),
    ],
    "j": [
        ("jf_alpha", "Alpha (female)", "female"),
        ("jm_kumo",  "Kumo (male)",    "male"),
    ],
    "z": [
        ("zf_xiaobei", "Xiaobei (female)",  "female"),
        ("zf_xiaoni",  "Xiaoni (female)",   "female"),
        ("zm_yunjian", "Yunjian (male)",    "male"),
    ],
    "e": [
        ("ef_dora", "Dora (female)", "female"),
        ("em_alex", "Alex (male)",   "male"),
    ],
    "f": [
        ("ff_siwis", "Siwis (female)", "female"),
    ],
    "h": [
        ("hf_alpha", "Alpha (female)", "female"),
        ("hm_omega", "Omega (male)",   "male"),
    ],
    "i": [
        ("if_sara",   "Sara (female)",   "female"),
        ("im_nicola", "Nicola (male)",   "male"),
    ],
    "p": [
        ("pf_dora", "Dora (female)", "female"),
        ("pm_alex", "Alex (male)",   "male"),
    ],
}

# Our lang_code → kokoro lang tag (passed only if the config accepts it).
LANG_TO_KOKORO = {"a": "en", "b": "en", "j": "ja", "z": "zh", "e": "es",
                  "f": "fr", "h": "hi", "i": "it", "p": "pt"}

VOICE_PREFIX_TO_LANG = {}
for lc, voices in VOICE_CATALOG.items():
    for vid, _, _ in voices:
        VOICE_PREFIX_TO_LANG[vid[:2]] = lc


def _model_dir() -> str:
    override = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else ""
    if override in ("hexgrad/Kokoro-82M", "hexgrad/kokoro-82m"):
        print(f"[tts] Legacy repo id '{override}' is from the torch era — "
              f"using vendored bundle instead.", flush=True)
        return DEFAULT_MODEL_DIR
    if override and os.path.isdir(override):
        return os.path.abspath(override)
    if override:
        print(f"[tts] Model dir '{override}' not found — using vendored bundle.",
              flush=True)
    return DEFAULT_MODEL_DIR


def _find(rel_dir: str, patterns: list[str]) -> str | None:
    for pat in patterns:
        hits = sorted(glob.glob(os.path.join(rel_dir, "**", pat), recursive=True))
        if hits:
            return hits[0]
    return None


class _TtsEngine:
    """Lazy sherpa-onnx Kokoro wrapper, one pipeline per language tag."""

    def __init__(self):
        self.model_dir = _model_dir()
        self.pipelines: dict[str, object] = {}
        self.sample_rate = 24000
        self.ready_error: str | None = None
        self.onnx = _find(self.model_dir, ["model.onnx", "*.onnx"])
        self.voices = _find(self.model_dir, ["voices.bin"])
        self.tokens = _find(self.model_dir, ["tokens.txt"])
        self.data_dir = next(
            (d for d in glob.glob(os.path.join(self.model_dir, "**", "espeak-ng-data"),
                                  recursive=True) if os.path.isdir(d)), None)
        missing = [n for n, p in (("model.onnx", self.onnx), ("voices.bin", self.voices),
                                  ("tokens.txt", self.tokens),
                                  ("espeak-ng-data", self.data_dir)) if not p]
        if missing:
            self.ready_error = (
                f"TTS bundle incomplete in {self.model_dir} "
                f"(missing: {', '.join(missing)}). "
                "Run: python src-tauri/sidecars/fetch_sidecars.py --tts")
        else:
            print(f"[tts] Bundle: {self.model_dir}", flush=True)

    @property
    def loaded(self) -> bool:
        return bool(self.pipelines)

    def _load_sherpa(self):
        try:
            import sherpa_onnx
        except ImportError:
            raise RuntimeError("sherpa-onnx not installed. Run: pip install -r "
                               "src-tauri/sidecars/requirements.txt")
        return sherpa_onnx

    def _kokoro_config(self, sherpa_onnx, kokoro_lang: str):
        """Full kwargs first (lang/lexicon/dict_dir when accepted), then
        minimal. pybind11 classes hide signatures, so probe by construction
        instead of inspect.signature (which raises ValueError)."""
        base: dict = {"model": self.onnx, "voices": self.voices,
                      "tokens": self.tokens, "data_dir": self.data_dir}
        extras: dict = {}
        lexicon = _find(self.model_dir, ["lexicon.txt"])
        if lexicon:
            extras["lexicon"] = lexicon
        dict_dir = _find(self.model_dir, ["dict", "jieba*"])
        if dict_dir and os.path.isdir(dict_dir):
            extras["dict_dir"] = dict_dir
        extras["lang"] = kokoro_lang
        try:
            return sherpa_onnx.OfflineTtsKokoroModelConfig(**base, **extras)
        except TypeError as e:
            print(f"[tts] Full kokoro config rejected ({e}) — retrying minimal.",
                  flush=True)
            return sherpa_onnx.OfflineTtsKokoroModelConfig(**base)

    def _pipeline(self, lang_code: str):
        kokoro_lang = LANG_TO_KOKORO.get(lang_code, "en")
        if kokoro_lang in self.pipelines:
            return self.pipelines[kokoro_lang]
        if self.ready_error:
            raise RuntimeError(self.ready_error)
        sherpa_onnx = self._load_sherpa()
        print(f"[tts] Loading kokoro (lang={kokoro_lang})...", flush=True)
        kokoro_cfg = self._kokoro_config(sherpa_onnx, kokoro_lang)
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro_cfg, num_threads=2)
        tts_cfg = sherpa_onnx.OfflineTtsConfig(model=model_cfg)
        tts = sherpa_onnx.OfflineTts(tts_cfg)
        self.sample_rate = tts.sample_rate
        self.pipelines[kokoro_lang] = tts
        print(f"[tts] Kokoro ready (lang={kokoro_lang}, {self.sample_rate} Hz)",
              flush=True)
        return tts

    def resolve_voice(self, voice: str) -> tuple[int, str | None]:
        """Voice id → (sid, fallback_note). Unknown ids fall back to af_heart."""
        if voice in VOICE_TO_SID:
            return VOICE_TO_SID[voice], None
        return VOICE_TO_SID[FALLBACK_VOICE], voice

    def synth(self, text: str, sid: int, speed: float,
              lang_code: str) -> "object | None":
        import numpy as np
        tts = self._pipeline(lang_code)
        audio = tts.generate(text, sid=sid, speed=speed)
        if audio is None or len(audio.samples) == 0:
            return None
        return np.array(audio.samples, dtype=np.float32)


_ENGINE: _TtsEngine | None = None


def _engine() -> _TtsEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = _TtsEngine()
    return _ENGINE


# ── Sentence-boundary chunking (A9.3) ────────────────────────────
_SENTENCE_RE = re.compile(r"(?<=[.!?;:\n])\s+")


def _chunk_text(text: str, max_tokens: int = 150,
                split_pattern: str = r"\n+") -> list[str]:
    sections = re.split(split_pattern, text.strip())
    if not sections:
        return []
    chunks = []
    for section in sections:
        section = section.strip()
        if not section:
            continue
        sentences = _SENTENCE_RE.split(section)
        current: list[str] = []
        current_len = 0
        for s in sentences:
            s = s.strip()
            if not s:
                continue
            est_tokens = int(len(s.split()) * 1.3)
            if current_len + est_tokens > max_tokens and current:
                chunks.append(" ".join(current))
                current = [s]
                current_len = est_tokens
            else:
                current.append(s)
                current_len += est_tokens
        if current:
            chunks.append(" ".join(current))
    return chunks


def synthesize(text: str, voice: str = "af_heart", speed: float = 1.0,
               lang_code: str = "a", split_pattern: str = r"\n+",
               chunk_size: int = 150) -> tuple[bytes, int, str | None]:
    """Synthesize text → (WAV bytes, sample_rate, voice_fallback_note)."""
    import numpy as np
    eng = _engine()
    if voice and not voice.startswith(lang_code):
        prefix = voice[:2]
        if prefix in VOICE_PREFIX_TO_LANG:
            lang_code = VOICE_PREFIX_TO_LANG[prefix]
    sid, fallback = eng.resolve_voice(voice)
    if fallback:
        print(f"[tts] Voice '{fallback}' not in v1.0 bundle — "
              f"using {FALLBACK_VOICE}.", flush=True)
    chunks = _chunk_text(text, max_tokens=chunk_size, split_pattern=split_pattern)
    all_audio = []
    for chunk in chunks:
        try:
            samples = eng.synth(chunk, sid, speed, lang_code)
            if samples is not None and len(samples) > 0:
                all_audio.append(samples)
        except Exception as e:
            print(f"[tts] Chunk error: {e}", flush=True)
            continue
    if not all_audio:
        return b"", eng.sample_rate, fallback
    combined = np.concatenate(all_audio)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(eng.sample_rate)
        pcm = (combined * 32767).clip(-32768, 32767).astype(np.int16)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue(), eng.sample_rate, fallback


# ── HTTP handler ─────────────────────────────────────────────────
class TtsHandler(BaseHTTPRequestHandler):
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

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "model_loaded": _engine().loaded})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        routes = {
            "/synthesize": self._handle_synthesize,
            "/voices": self._handle_voices,
            "/stop": lambda: self._json({"status": "stopped"}),
        }
        handler = routes.get(self.path)
        if handler:
            handler()
        else:
            self._json({"error": "not found"}, 404)

    def _handle_synthesize(self):
        raw = self._read_body()
        if not raw:
            self._json({"error": "empty body"}, 400)
            return
        try:
            data = json.loads(raw)
            text = data.get("text", "")
            if not text.strip():
                self._json({"error": "empty text"}, 400)
                return
            wav_bytes, sr, fallback = synthesize(
                text,
                voice=data.get("voice", "af_heart"),
                speed=float(data.get("speed", 1.0)),
                lang_code=data.get("lang_code", "a"),
                split_pattern=data.get("split_pattern", r"\n+"),
                chunk_size=int(data.get("chunk_size", 150)),
            )
            resp: dict = {
                "audio": base64.b64encode(wav_bytes).decode() if wav_bytes else "",
                "sample_rate": sr,
                "format": "wav",
            }
            if fallback:
                resp["voice_fallback"] = fallback
            self._json(resp)
        except Exception as e:
            print(f"[tts] Error: {e}", flush=True)
            self._json({"error": str(e)}, 500)

    def _handle_voices(self):
        raw = self._read_body()
        try:
            data = json.loads(raw) if raw else {}
            lang = data.get("lang_code", "a")
            voices = VOICE_CATALOG.get(lang, VOICE_CATALOG["a"])
            self._json({
                "voices": [{"id": v[0], "label": v[1], "gender": v[2]} for v in voices],
                "current_lang": lang,
            })
        except Exception as e:
            self._json({"error": str(e)}, 500)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    server = HTTPServer(("127.0.0.1", port), TtsHandler)
    print(f"[tts] Kokoro TTS (sherpa-onnx) on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
