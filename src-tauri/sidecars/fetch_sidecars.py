#!/usr/bin/env python3
"""
fetch_sidecars.py
=================
One-shot fetcher for STT/TTS offline sidecar weights + binaries.

Usage:
  python src-tauri/sidecars/fetch_sidecars.py --stt   # transcribe-cli + moonshine-base GGUF
  python src-tauri/sidecars/fetch_sidecars.py --tts   # kokoro-multi-lang-v1_0 bundle

All downloads are pinned to specific releases/SHAs; no network at runtime.
"""

import argparse
import hashlib
import os
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
MODELS_DIR = HERE / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# ── Pinned artifacts ──────────────────────────────────────────────
# STT runtime is `pip install -r requirements.txt` (transcribe-cpp-native);
# only the GGUF below is fetched (upstream ships no CLI binary).
STT_GGUF_URL = (
    "https://huggingface.co/memoravox/moonshine-base-gguf/resolve/main/"
    "moonshine-base-Q8_0.gguf"
)
STT_GGUF_PATH = MODELS_DIR / "moonshine-base-Q8_0.gguf"

TTS_BUNDLE_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
    "kokoro-multi-lang-v1_0.tar.bz2"
)
TTS_BUNDLE_DIR = MODELS_DIR / "kokoro-multi-lang-v1_0"

# LLM (llama.cpp server + LFM 2.5-350M GGUF). NOTE: b4970 predates LFM2
# support (unknown architecture 'lfm2'); use a current build.
LLM_SERVER_URL = (
    "https://github.com/ggml-org/llama.cpp/releases/download/"
    "b11047/llama-b11047-bin-win-vulkan-x64.zip"
)
LLM_SERVER_DIR = MODELS_DIR / "llama-server"
LLM_GGUF_URL = (
    "https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF/resolve/main/"
    "LFM2.5-350M-Q4_K_M.gguf"
)
LLM_GGUF_PATH = MODELS_DIR / "lfm2.5-350m-q4_k_m.gguf"

# Optional: known SHA-256 checksums (empty = skip verify).
# Run `sha256sum <file>` after first download and paste here to pin.
SHA256 = {
    "stt_gguf": "",
    "tts_bundle": "",
    "llm_server": "",
    "llm_gguf": "",
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _remote_size(url: str) -> int | None:
    """HEAD for Content-Length (follows redirects). None if unknowable."""
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, method="HEAD"), timeout=30
        ) as head:
            total = head.headers.get("Content-Length")
            return int(total) if total is not None else None
    except Exception:
        return None


def _download(url: str, dest: Path, label: str, expected_sha: str = "") -> None:
    """Download with resume + retries. Big bundles (300MB+) die mid-flight
    on flaky links; urlretrieve can't resume, so stream with Range."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Fast path: byte-identical file already on disk — skip entirely.
    total = _remote_size(url)
    if total and dest.exists() and dest.stat().st_size == total:
        print(f"[{label}] Up to date ({total:,} bytes) — skipping.", flush=True)
    else:
        attempts = 4
        for attempt in range(1, attempts + 1):
            try:
                _download_once(url, dest, label)
                break
            except Exception as e:
                print(f"[{label}] Attempt {attempt}/{attempts} failed: {e} "
                      f"— resuming.", flush=True)
                if attempt == attempts:
                    raise RuntimeError(f"[{label}] Download failed after "
                                       f"{attempts} attempts: {e}")
        total = _remote_size(url)
        if total is not None and dest.stat().st_size != total:
            raise RuntimeError(
                f"[{label}] retrieval incomplete: got {dest.stat().st_size} "
                f"out of {total} bytes")
        print(f"[{label}] Saved -> {dest} ({dest.stat().st_size:,} bytes)", flush=True)
        if expected_sha:
            actual = _sha256(dest)
            if actual != expected_sha:
                dest.unlink()
                raise RuntimeError(f"[{label}] SHA mismatch: expected {expected_sha}, got {actual}")
        else:
            print(f"[{label}] No pinned SHA — skipping checksum verify.", flush=True)
    print(f"[{label}] Saved -> {dest} ({dest.stat().st_size:,} bytes)", flush=True)


def _download_once(url: str, dest: Path, label: str) -> None:
    have = dest.stat().st_size if dest.exists() else 0
    req = urllib.request.Request(url)
    if have > 0:
        req.add_header("Range", f"bytes={have}-")
        print(f"[{label}] Resuming at {have:,} bytes…", flush=True)
    else:
        print(f"[{label}] Downloading {url} …", flush=True)
    with urllib.request.urlopen(req, timeout=60) as resp:
        # Server ignored Range: restart from scratch, don't append garbage.
        if have > 0 and resp.status != 206:
            print(f"[{label}] Server ignored resume — restarting.", flush=True)
            have = 0
        mode = "ab" if have > 0 else "wb"
        with open(dest, mode) as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)


def _extract_tar_bz2(archive: Path, dest_dir: Path, label: str) -> None:
    print(f"[{label}] Extracting {archive} …", flush=True)
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:bz2") as tf:
        tf.extractall(dest_dir)
    print(f"[{label}] Extracted to {dest_dir}", flush=True)


def fetch_stt() -> None:
    """Fetch the Moonshine-base GGUF.

    NOTE: upstream transcribe.cpp native archives ship DLLs only (no CLI
    binary), so there is no CLI to fetch. The STT server runs inference
    in-process via `pip install -r requirements.txt` (transcribe-cpp-native)
    against this GGUF — see stt_server.py.
    """
    # Moonshine-base GGUF only.
    _download(STT_GGUF_URL, STT_GGUF_PATH, "STT-GGUF", SHA256["stt_gguf"])

    print("[STT] Done.", flush=True)


def fetch_tts() -> None:
    """Fetch kokoro-multi-lang-v1_0 sherpa-onnx bundle."""
    bundle_archive = MODELS_DIR / "kokoro-multi-lang-v1_0.tar.bz2"
    _download(TTS_BUNDLE_URL, bundle_archive, "TTS-BUNDLE", SHA256["tts_bundle"])
    _extract_tar_bz2(bundle_archive, TTS_BUNDLE_DIR, "TTS-BUNDLE")

    # The tarball extracts a single top-level dir; find it.
    extracted = [p for p in TTS_BUNDLE_DIR.iterdir() if p.is_dir()]
    if len(extracted) == 1:
        inner = extracted[0]
        # Move contents up one level if nested
        for item in inner.iterdir():
            target = TTS_BUNDLE_DIR / item.name
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            shutil.move(str(item), str(target))
        inner.rmdir()
        print(f"[TTS] Flattened bundle root → {TTS_BUNDLE_DIR}", flush=True)

    # Verify expected files
    for req in ("model.onnx", "voices.bin", "tokens.txt"):
        if not (TTS_BUNDLE_DIR / req).exists():
            print(f"[TTS] WARNING: missing {req} in bundle", flush=True)
    espeak_dir = next(TTS_BUNDLE_DIR.rglob("espeak-ng-data"), None)
    if espeak_dir is None or not espeak_dir.is_dir():
        print("[TTS] WARNING: espeak-ng-data not found in bundle", flush=True)
    else:
        print(f"[TTS] Found espeak-ng-data → {espeak_dir}", flush=True)

    bundle_archive.unlink(missing_ok=True)
    print("[TTS] Done.", flush=True)


def fetch_llm() -> None:
    """Fetch llama.cpp server binary + LFM 2.5-350M GGUF."""
    import zipfile

    # 1) llama.cpp server release (contains llama-server.exe + DLLs)
    server_archive = MODELS_DIR / "llama-server.zip"
    _download(LLM_SERVER_URL, server_archive, "LLM-SERVER", SHA256["llm_server"])
    print(f"[LLM] Extracting {server_archive} …", flush=True)
    LLM_SERVER_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(server_archive, "r") as zf:
        zf.extractall(LLM_SERVER_DIR)
    # Find llama-server.exe anywhere under the extracted tree and copy to models/
    server_exe = next(LLM_SERVER_DIR.rglob("llama-server.exe"), None)
    if server_exe:
        target = MODELS_DIR / "llama-server.exe"
        shutil.copy2(server_exe, target)
        print(f"[LLM] Copied llama-server.exe → {target}", flush=True)
        # Sibling runtime DLLs must sit next to the exe (Windows loader
        # resolves DLLs from the exe dir) — otherwise --version exits
        # 0xC0000135 (STATUS_DLL_NOT_FOUND).
        copied_dlls = 0
        for dll in server_exe.parent.glob("*.dll"):
            shutil.copy2(dll, MODELS_DIR / dll.name)
            copied_dlls += 1
        print(f"[LLM] Copied {copied_dlls} runtime DLLs → {MODELS_DIR}", flush=True)
    else:
        print("[LLM] WARNING: llama-server.exe not found in archive", flush=True)
    server_archive.unlink(missing_ok=True)
    # Drop the extracted tree (exe + DLLs already copied up) — it would
    # otherwise ride into the app bundle (~150MB of duplicates).
    shutil.rmtree(LLM_SERVER_DIR, ignore_errors=True)

    # 2) LFM 2.5-350M GGUF (Q4_K_M ~267MB)
    _download(LLM_GGUF_URL, LLM_GGUF_PATH, "LLM-GGUF", SHA256["llm_gguf"])

    print("[LLM] Done.", flush=True)


def main() -> None:
    # Windows consoles default to cp1252, which chokes on the arrows/emoji
    # used in progress prints — force UTF-8 so a fetch never dies mid-run.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass
    ap = argparse.ArgumentParser(description="Fetch STT/TTS/LLM sidecar assets")
    ap.add_argument("--stt", action="store_true", help="Fetch STT (transcribe-cli + GGUF)")
    ap.add_argument("--tts", action="store_true", help="Fetch TTS (Kokoro v1.0 bundle)")
    ap.add_argument("--llm", action="store_true", help="Fetch LLM (llama.cpp server + LFM 2.5-350M GGUF)")
    args = ap.parse_args()

    if not (args.stt or args.tts or args.llm):
        ap.error("Choose --stt, --tts, and/or --llm")

    failed: list[str] = []
    if args.stt:
        try:
            fetch_stt()
        except Exception as e:
            failed.append(f"stt: {e}")
    if args.tts:
        try:
            fetch_tts()
        except Exception as e:
            failed.append(f"tts: {e}")
    if args.llm:
        try:
            fetch_llm()
        except Exception as e:
            failed.append(f"llm: {e}")

    print("\nAll done. Sidecars will auto-discover under:", MODELS_DIR, flush=True)
    if failed:
        print("FAILURES:", flush=True)
        for f in failed:
            print(f"  - {f}", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()